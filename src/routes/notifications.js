const express = require('express')
const { protect, authorize, canAccessBranch } = require('../middleware/auth')
const { findMany, findById, updateById, updateWhere, deleteById } = require('../lib/supabaseRepo')
const { sameId } = require('../utils/common')
const notifySvc = require('../services/notificationService')

const router = express.Router()
const toPositiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Loads :id and makes sure it belongs to the signed-in user.
const loadOwnNotification = async (req, res, next) => {
  try {
    const notification = await findById('notifications', req.params.id)
    if (!notification || !sameId(notification.user, req.user.id)) {
      return res.status(404).json({ message: 'Notification not found.' })
    }
    req.notification = notification
    next()
  } catch (err) { next(err) }
}

router.get('/', protect, async (req, res, next) => {
  try {
    const page = toPositiveInt(req.query.page, 1)
    const limit = Math.min(toPositiveInt(req.query.limit, 20), 100)
    const [notifications, unreadRows] = await Promise.all([
      findMany('notifications', {
        filters: [['user', 'eq', req.user.id]],
        order: { column: 'created_at', ascending: false },
        range: { from: (page - 1) * limit, to: page * limit - 1 },
      }),
      findMany('notifications', { select: 'id', filters: [['user', 'eq', req.user.id], ['read', 'eq', false]] }),
    ])
    res.json({ notifications, unread: unreadRows.length })
  } catch (err) { next(err) }
})

router.patch('/read-all', protect, async (req, res, next) => {
  try {
    await updateWhere('notifications', [['user', 'eq', req.user.id], ['read', 'eq', false]], { read: true })
    res.json({ message: 'All notifications marked as read.' })
  } catch (err) { next(err) }
})

router.patch('/:id/read', protect, loadOwnNotification, async (req, res, next) => {
  try {
    await updateById('notifications', req.notification.id, { read: true })
    res.json({ message: 'Marked as read.' })
  } catch (err) { next(err) }
})

router.delete('/:id', protect, loadOwnNotification, async (req, res, next) => {
  try {
    await deleteById('notifications', req.notification.id)
    res.json({ message: 'Notification deleted.' })
  } catch (err) { next(err) }
})

router.post('/send-ticket/:ticketId', protect, authorize('staff', 'branch_admin', 'super_admin'), async (req, res, next) => {
  try {
    const ticket = await findById('queues', req.params.ticketId)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    if (!canAccessBranch(req.user, ticket.branch)) {
      return res.status(403).json({ message: 'You can only message customers of your own branch.' })
    }

    const preferredChannel = req.body.channel || ticket.notify_channel || 'email'
    const channel = ['email', 'sms', 'both'].includes(preferredChannel) ? preferredChannel : 'email'
    const type = ['info', 'success', 'warning', 'error'].includes(req.body.type) ? req.body.type : 'info'
    const title = String(req.body.title || 'SmartQueue Update').slice(0, 120)
    const message = String(req.body.message || `Hello ${ticket.name}, this is a SmartQueue message regarding ticket ${ticket.ticket_number}.`).slice(0, 1000)

    const notification = await notifySvc.notify({
      userId: ticket.user,
      type,
      title,
      message,
      channel,
      email: ticket.email,
      phone: ticket.phone,
    })

    if (ticket.user) {
      req.app.get('io')?.emitToUser(ticket.user, 'notification:new', {
        _id: notification.id,
        type,
        title,
        message,
        read: false,
        createdAt: new Date(),
      })
    }

    res.status(201).json({
      message: notification.channels?.email?.sent === false && (channel === 'email' || channel === 'both')
        ? 'Notification was saved, but the email was not delivered.'
        : 'Notification sent.',
      channel,
      delivery: notification.channels,
      ticket: {
        _id: ticket.id,
        ticketNumber: ticket.ticket_number,
        notifyChannel: ticket.notify_channel,
      },
    })
  } catch (err) { next(err) }
})

module.exports = router
