const { findById } = require('../lib/supabaseRepo')
const { readCookieToken, verifyToken } = require('../middleware/auth')
const { toPublicTicket } = require('../services/queueService')

const getBranchRoom = (branchId) => `branch:${branchId}`
const getBranchQueueRoom = (branchId) => `queue:${branchId}`

// Queue events carry ticket rows. Staff rooms get them as-is; the public room
// (lobby screens, anonymous trackers) only gets fields without contact details.
const toPublicPayload = (data) => (data && data.ticket_number !== undefined ? toPublicTicket(data) : data)

module.exports = (io) => {
  const extractSocketToken = (socket) =>
    socket.handshake.auth?.token ||
    socket.handshake.query?.token ||
    readCookieToken(socket.handshake.headers?.cookie)

  io.use(async (socket, next) => {
    socket.user = null
    const token = extractSocketToken(socket)
    const decoded = token && verifyToken(token)
    if (!decoded) return next()

    try {
      const user = await findById('users', decoded.id)
      if (user && user.status !== 'suspended') socket.user = user
    } catch (err) {
      console.error('[socket] auth lookup failed:', err.message)
    }
    next()
  })

  io.on('connection', (socket) => {
    const userId = socket.user?.id?.toString()
    if (userId) socket.join(`user:${userId}`)

    socket.on('join:branch', ({ branchId } = {}) => {
      if (!branchId) return

      const user = socket.user
      const isSuper = user?.role === 'super_admin'
      const isBranchStaff = user && ['branch_admin', 'staff'].includes(user.role) && String(user.branch) === String(branchId)

      // Only the branch's own team (or a super admin) receives full ticket data.
      if (isSuper || isBranchStaff) socket.join(getBranchRoom(branchId))
      // Anyone (including public TV displays) can listen to public queue updates.
      socket.join(getBranchQueueRoom(branchId))
    })

    socket.on('leave:branch', ({ branchId } = {}) => {
      if (!branchId) return
      socket.leave(getBranchRoom(branchId))
      socket.leave(getBranchQueueRoom(branchId))
    })

    socket.on('join:queue', (queueId) => {
      if (!queueId) return
      socket.join(getBranchQueueRoom(queueId))
    })

    socket.on('leave:queue', (queueId) => {
      if (!queueId) return
      socket.leave(getBranchQueueRoom(queueId))
    })

    // Users can only join their own user room.
    socket.on('join:user', ({ userId: uid } = {}) => {
      if (!uid) return
      if (!socket.user || String(socket.user.id) !== String(uid)) {
        console.warn(`[Socket Auth Warning] User ${socket.user?.id} attempted unauthorized room join for user:${uid}`)
        return
      }
      socket.join(`user:${uid}`)
    })
  })

  io.emitToBranch = (branchId, event, data) => {
    if (!branchId) return
    const publicData = toPublicPayload(data)
    // A socket in both rooms would otherwise receive each event twice.
    io.to(getBranchRoom(branchId)).emit(event, data)
    io.to(getBranchQueueRoom(branchId)).except(getBranchRoom(branchId)).emit(event, publicData)
    io.to(getBranchRoom(branchId)).emit('queue:updated', data)
    io.to(getBranchQueueRoom(branchId)).except(getBranchRoom(branchId)).emit('queue:updated', publicData)
  }

  io.emitToUser = (userId, event, data) => {
    if (!userId) return
    io.to(`user:${userId}`).emit(event, data)
  }

  // Immediately revokes active socket sessions for a user (e.g., on suspension or demotion).
  io.revokeUserSockets = (userId) => {
    if (!userId) return
    const roomName = `user:${userId}`
    io.in(roomName).emit('session:revoked', { message: 'Your session or permissions have changed. Please log in again.' })
    io.in(roomName).disconnectSockets(true)
  }

  return io
}
