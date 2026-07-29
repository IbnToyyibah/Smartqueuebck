const express = require('express')
const { protect } = require('../middleware/auth')
const { findMany, updateById, deleteById, findById } = require('../lib/supabaseRepo')
const notifySvc = require('../services/notificationService')

const router = express.Router()

router.get('/', protect, async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1)
    const limit = Number(req.query.limit || 20)
    const notifications = await findMany('notifications', {
      filters: [['user', 'eq', req.user.id]],
      order: { column: 'created_at', ascending: false },
      range: { from: (page - 1) * limit, to: page * limit - 1 },
    })
    const unread = notifications.filter((n) => !n.read).length
    res.json({ notifications, unread })
  } catch (err) { next(err) }
})

router.patch('/:id/read', protect, async (req, res, next) => {
  try {
    await updateById('notifications', req.params.id, { read: true })
    res.json({ message: 'Marked as read.' })
  } catch (err) { next(err) }
})

router.patch('/read-all', protect, async (req, res, next) => {
  try {
    const notifications = await findMany('notifications', { filters: [['user', 'eq', req.user.id], ['read', 'eq', false]] })
    for (const n of notifications) {
      await updateById('notifications', n.id, { read: true })
    }
    res.json({ message: 'All notifications marked as read.' })
  } catch (err) { next(err) }
})

router.delete('/:id', protect, async (req, res, next) => {
  try {
    await deleteById('notifications', req.params.id)
    res.json({ message: 'Notification deleted.' })
  } catch (err) { next(err) }
})

router.post('/send-ticket/:ticketId', protect, async (req, res, next) => {
  try {
    if (!['staff', 'branch_admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'You are not allowed to send notifications.' })
    }
    const ticket = await findById('queues', req.params.ticketId)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })

    const preferredChannel = req.body.channel || ticket.notify_channel || 'email'
    const channel = ['email', 'sms', 'both'].includes(preferredChannel) ? preferredChannel : 'email'
    const title = req.body.title || 'SmartQueue Update'
    const message = req.body.message || `Hello ${ticket.name}, this is a SmartQueue message regarding ticket ${ticket.ticket_number}.`

    const notification = await notifySvc.notify({
      userId: ticket.user,
      type: req.body.type || 'info',
      title,
      message,
      channel,
      email: ticket.email,
      phone: ticket.phone,
    })

    const io = req.app.get('io')
    if (io && ticket.user) {
      io.to(`user:${ticket.user}`).emit('notification:new', {
        _id: notification.id,
        type: req.body.type || 'info',
        title,
        message,
        read: false,
        createdAt: new Date(),
      })
    }

    res.status(201).json({
      message: 'Notification sent.',
      channel,
      ticket: {
        _id: ticket.id,
        ticketNumber: ticket.ticket_number,
        notifyChannel: ticket.notify_channel,
      },
    })
  } catch (err) { next(err) }
})

module.exports = router
