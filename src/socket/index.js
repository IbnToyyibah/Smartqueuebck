const jwt = require('jsonwebtoken')
const { findById } = require('../lib/supabaseRepo')

module.exports = (io) => {
  const getBranchRoom = (branchId) => `branch:${branchId}`
  const getBranchQueueRoom = (branchId) => `queue:${branchId}`

  const extractSocketToken = (socket) => {
    let token = socket.handshake.auth?.token || socket.handshake.query?.token
    if (token) return token
    const cookieHeader = socket.handshake.headers?.cookie
    if (cookieHeader) {
      const match = cookieHeader.match(/sq_token=([^;]+)/)
      if (match) return match[1]
    }
    return null
  }

  io.use(async (socket, next) => {
    const token = extractSocketToken(socket)
    if (!token) {
      socket.user = null
      return next()
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await findById('users', decoded.id)
      if (user && user.status !== 'suspended') {
        socket.user = user
      } else {
        socket.user = null
      }
    } catch {
      socket.user = null
    }

    next()
  })

  io.on('connection', (socket) => {
    const userId = socket.user?.id?.toString()
    if (userId) socket.join(`user:${userId}`)

    // Authorized join to branch management rooms
    socket.on('join:branch', ({ branchId }) => {
      if (!branchId) return

      const user = socket.user
      // Check permission: public/customers can join queue display rooms, but branch management room requires branch access
      const isSuper = user?.role === 'super_admin'
      const isBranchStaff = user && ['branch_admin', 'staff'].includes(user.role) && String(user.branch) === String(branchId)

      if (isSuper || isBranchStaff) {
        socket.join(getBranchRoom(branchId))
      }
      // Anyone (including public TV displays) can listen to public queue updates
      socket.join(getBranchQueueRoom(branchId))
    })

    socket.on('leave:branch', ({ branchId }) => {
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

    // Strict user room authorization: users can ONLY join their own user room!
    socket.on('join:user', ({ userId: uid }) => {
      if (!uid) return
      if (!socket.user || String(socket.user.id) !== String(uid)) {
        console.warn(`[Socket Auth Warning] User ${socket.user?.id} attempted unauthorized room join for user:${uid}`)
        return
      }
      socket.join(`user:${uid}`)
    })
  })

  io.emitToBranch = (branchId, event, data) => {
    io.to(getBranchRoom(branchId)).emit(event, data)
    io.to(getBranchQueueRoom(branchId)).emit(event, data)
    io.to(getBranchQueueRoom(branchId)).emit('queue:updated', data)
  }

  io.emitToUser = (userId, event, data) => {
    io.to(`user:${userId}`).emit(event, data)
  }

  /**
   * Immediately revokes active socket sessions for a user (e.g., on suspension or demotion)
   */
  io.revokeUserSockets = (userId) => {
    if (!userId) return
    const roomName = `user:${userId}`
    io.in(roomName).emit('session:revoked', { message: 'Your session or permissions have changed. Please log in again.' })
    io.in(roomName).disconnectSockets(true)
  }

  return io
}
