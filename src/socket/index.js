const jwt = require('jsonwebtoken')
const { findById } = require('../lib/supabaseRepo')

module.exports = (io) => {
  const getBranchRoom = (branchId) => `branch:${branchId}`
  const getBranchQueueRoom = (branchId) => `queue:${branchId}`

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token
    if (!token) {
      socket.user = null
      return next()
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      socket.user = await findById('users', decoded.id)
    } catch {
      socket.user = null
    }

    next()
  })

  io.on('connection', (socket) => {
    const userId = socket.user?.id?.toString()
    if (userId) socket.join(`user:${userId}`)

    socket.on('join:branch', ({ branchId }) => {
      if (!branchId) return
      socket.join(getBranchRoom(branchId))
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

    socket.on('join:user', ({ userId: uid }) => {
      if (!uid) return
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

  return io
}
