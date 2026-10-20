const express = require('express')
const { protect, authorize, optionalAuth, requireActiveBranch, requireOwnBranch } = require('../middleware/auth')
const branchActiveCheck = require('../middleware/branchActiveCheck')
const queueSvc = require('../services/queueService')
const notifySvc = require('../services/notificationService')
const { findById, updateById } = require('../lib/supabaseRepo')

const router = express.Router()

const emit = (req, event, data) => {
  const io = req.app.get('io')
  if (!io) return
  const branchId = String(data.branch?.id || data.branch)
  if (typeof io.emitToBranch === 'function') {
    io.emitToBranch(branchId, event, data)
    return
  }
  io.to(`branch:${branchId}`).emit(event, data)
  io.to(`queue:${branchId}`).emit(event, data)
  io.to(`queue:${branchId}`).emit('queue:updated', data)
}

const requireAssignedCounter = async (req, res, counterId) => {
  if (req.user.role !== 'staff') return true
  const counter = await findById('counters', counterId)
  if (!counter) {
    res.status(404).json({ message: 'Counter not found.' })
    return false
  }
  if (String(counter.agent) !== String(req.user.id)) {
    return res.status(403).json({ message: 'You can only serve customers from your assigned counter.' })
  }
  return true
}

router.post('/join', optionalAuth, branchActiveCheck, async (req, res, next) => {
  try {
    const { branch_id, service_id, time_slot, name, email, phone, notify_channel } = req.body
    if (!String(branch_id || '').trim() || !String(service_id || '').trim() || !String(name || '').trim()) {
      return res.status(400).json({ message: 'branch_id, service_id, and name are required.' })
    }

    const ticket = await queueSvc.joinQueue({
      branchId: branch_id,
      userId: req.user?.id || null,
      name,
      email: email || req.user?.email || '',
      phone: phone || req.user?.phone || '',
      serviceId: service_id,
      notifyChannel: notify_channel || req.user?.notify_channel || 'email',
      timeSlot: time_slot,
    })

    emit(req, 'queue:joined', ticket)

    if (req.user || email) {
      const ticketNumber = ticket.ticket_number || ticket.ticketNumber
      const tpl = notifySvc.templates.ticketConfirmed({
        ticketNumber,
        estimatedWait: ticket.estimated_wait || ticket.estimatedWait,
        branchName: ticket.branch?.name || '',
        serviceName: ticket.service?.name || ticket.service?.label || '',
      })
      if (req.user) {
        await notifySvc.notify({
          userId: req.user.id,
          ...tpl,
          channel: notify_channel || req.user.notify_channel || 'email',
          email: email || req.user.email,
          phone: phone || req.user.phone,
        })
      } else {
        // Guests do not have a notification record, but they should still
        // receive the same ticket confirmation at the email they supplied.
        const emailResult = await notifySvc.sendEmail({
          to: email,
          subject: `SmartQueue - ${tpl.title}`,
          text: tpl.message,
        })
        if (emailResult.error || emailResult.skipped) {
          console.error(`[notification] Guest ticket email was not sent to ${email}: ${emailResult.error || 'Email delivery is not configured.'}`)
        }
      }
    }

    res.status(201).json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.get('/my', protect, authorize('customer'), async (req, res, next) => {
  try {
    const tickets = await queueSvc.getBranchQueue(req.user.branch || req.user.id)
    const ticket = tickets.find((t) => t.user === req.user.id && ['waiting', 'called', 'serving'].includes(t.status)) || null
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.get('/history', protect, authorize('customer'), async (req, res, next) => {
  try {
    const tickets = await queueSvc.getBranchQueue(req.user.branch || req.user.id)
    res.json({ tickets: tickets.filter((t) => t.user === req.user.id && ['served', 'noshow', 'cancelled'].includes(t.status)).slice(0, 50) })
  } catch (err) {
    next(err)
  }
})

router.get('/branch/:branchId', protect, authorize('staff', 'branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const { status } = req.query
    const tickets = await queueSvc.getBranchQueue(req.params.branchId, status)
    res.json({ tickets })
  } catch (err) {
    next(err)
  }
})

// Public, read-only data for lobby displays. Keep customer contact details private.
router.get('/display/:branchId', async (req, res, next) => {
  try {
    const branch = await findById('branches', req.params.branchId, 'id,name,city,status')
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })

    const [tickets, counters] = await Promise.all([
      queueSvc.getBranchQueue(req.params.branchId),
      findMany('counters', { filters: [['branch', 'eq', req.params.branchId]], select: 'id,name,status' }),
    ])
    const counterNames = new Map(counters.map((counter) => [String(counter.id), counter.name]))
    const visibleTickets = tickets
      .filter((ticket) => ['called', 'serving', 'waiting'].includes(ticket.status))
      .map((ticket) => ({
        id: ticket.id,
        ticket_number: ticket.ticket_number || ticket.ticketNumber,
        status: ticket.status,
        position: ticket.position,
        service: ticket.service?.name || ticket.service?.label || 'General service',
        counter: counterNames.get(String(ticket.counter)) || null,
        called_at: ticket.called_at || null,
      }))

    res.json({ branch, tickets: visibleTickets, updated_at: new Date().toISOString() })
  } catch (err) {
    next(err)
  }
})

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const ticket = await findById('queues', req.params.id)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/call', protect, authorize('staff', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const { counter_id } = req.body
    if (!counter_id) return res.status(400).json({ message: 'counter_id required.' })
    if (!(await requireAssignedCounter(req, res, counter_id))) return
    const counter = await findById('counters', counter_id)
    if (!counter) return res.status(404).json({ message: 'Counter not found.' })
    if (req.user.role === 'branch_admin' && String(counter.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only call tickets from your own branch.' })
    }
    const branchId = req.user.branch
    const ticket = await queueSvc.callNext(counter_id, branchId)
    if (!ticket) return res.status(200).json({ message: 'No customers waiting.', ticket: null })

    emit(req, 'queue:called', ticket)
    if (ticket.user) {
      const counterDoc = await findById('counters', counter_id)
      const tpl = notifySvc.templates.ticketCalled({
        ticketNumber: ticket.ticket_number || ticket.ticketNumber,
        counterName: counterDoc?.name || 'the counter',
      })
      await notifySvc.notify({
        userId: ticket.user,
        ...tpl,
        channel: ticket.notify_channel,
        email: ticket.email,
        phone: ticket.phone,
      })
    }

    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/serve', protect, authorize('staff', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const { counter_id } = req.body
    if (counter_id && !(await requireAssignedCounter(req, res, counter_id))) return
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc) return res.status(404).json({ message: 'Ticket not found.' })
    if (req.user.role === 'branch_admin' && String(ticketDoc.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only serve tickets from your own branch.' })
    }
    const ticket = await queueSvc.markServed(req.params.id, counter_id)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    emit(req, 'queue:served', ticket)
    if (ticket.user) {
      const tpl = notifySvc.templates.ticketServed({ ticketNumber: ticket.ticket_number || ticket.ticketNumber })
      await notifySvc.notify({
        userId: ticket.user,
        ...tpl,
        channel: ticket.notify_channel,
        email: ticket.email,
        phone: ticket.phone,
      })
    }
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/noshow', protect, authorize('staff', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const { counter_id } = req.body
    if (counter_id && !(await requireAssignedCounter(req, res, counter_id))) return
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc) return res.status(404).json({ message: 'Ticket not found.' })
    if (req.user.role === 'branch_admin' && String(ticketDoc.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only mark no-shows for your own branch.' })
    }
    const ticket = await queueSvc.markNoShow(req.params.id, counter_id)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    emit(req, 'queue:noshow', ticket)
    if (ticket.user) {
      const tpl = notifySvc.templates.ticketNoShow({ ticketNumber: ticket.ticket_number || ticket.ticketNumber })
      await notifySvc.notify({
        userId: ticket.user,
        ...tpl,
        channel: ticket.notify_channel,
        email: ticket.email,
        phone: ticket.phone,
      })
    }
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/transfer', protect, authorize('staff', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const { to_counter_id } = req.body
    if (!to_counter_id) return res.status(400).json({ message: 'to_counter_id required.' })
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc) return res.status(404).json({ message: 'Ticket not found.' })
    if (req.user.role === 'branch_admin' && String(ticketDoc.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only transfer tickets from your own branch.' })
    }
    const ticket = await queueSvc.transferTicket(req.params.id, to_counter_id)
    emit(req, 'queue:transferred', ticket)
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id/rate', protect, authorize('customer'), async (req, res, next) => {
  try {
    const { rating } = req.body
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be 1-5.' })
    }
    const ticket = await updateById('queues', req.params.id, { rating })
    if (!ticket) return res.status(404).json({ message: 'Ticket not found or not eligible for rating.' })
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.get('/stats/:branchId', protect, authorize('branch_admin', 'super_admin'), async (req, res, next) => {
  try {
    if (req.user.role === 'branch_admin' && String(req.params.branchId) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only view stats for your own branch.' })
    }
    const days = Number(req.query.days) || 7
    const from = new Date()
    from.setDate(from.getDate() - days)
    const stats = await queueSvc.getBranchStats(req.params.branchId, from)
    res.json({ stats })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/checkin', optionalAuth, async (req, res, next) => {
  try {
    const ticket = await updateById('queues', req.params.id, { status: 'checked_in' })
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    const io = req.app.get('io')
    if (io && typeof io.emitToBranch === 'function') io.emitToBranch(String(ticket.branch), 'queue:checkedin', ticket)
    else if (io) {
      const branchId = String(ticket.branch)
      io.to(`branch:${branchId}`).emit('queue:checkedin', ticket)
      io.to(`queue:${branchId}`).emit('queue:checkedin', ticket)
      io.to(`queue:${branchId}`).emit('queue:updated', ticket)
    }
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/skip', protect, authorize('staff', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc) return res.status(404).json({ message: 'Ticket not found.' })
    if (req.user.role === 'branch_admin' && String(ticketDoc.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only skip tickets from your own branch.' })
    }
    const ticket = await updateById('queues', req.params.id, { status: 'skipped', counter: null, called_at: null })
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    const updated = await updateById('queues', req.params.id, { status: 'waiting' })
    await queueSvc.recalculatePositions(ticket.branch)
    const io = req.app.get('io')
    if (io && typeof io.emitToBranch === 'function') io.emitToBranch(String(ticket.branch), 'queue:skipped', updated)
    else if (io) {
      const branchId = String(ticket.branch)
      io.to(`branch:${branchId}`).emit('queue:skipped', updated)
      io.to(`queue:${branchId}`).emit('queue:skipped', updated)
      io.to(`queue:${branchId}`).emit('queue:updated', updated)
    }
    res.json({ ticket: updated })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/recall', protect, authorize('staff', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc) return res.status(404).json({ message: 'Ticket not found.' })
    if (req.user.role === 'branch_admin' && String(ticketDoc.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only recall tickets from your own branch.' })
    }
    const ticket = await updateById('queues', req.params.id, { status: 'called', called_at: new Date().toISOString() })
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    const io = req.app.get('io')
    if (io && typeof io.emitToBranch === 'function') io.emitToBranch(String(ticket.branch), 'queue:called', ticket)
    else if (io) {
      const branchId = String(ticket.branch)
      io.to(`branch:${branchId}`).emit('queue:called', ticket)
      io.to(`queue:${branchId}`).emit('queue:called', ticket)
      io.to(`queue:${branchId}`).emit('queue:updated', ticket)
    }
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.get('/lookup/:ticketNumber', async (req, res, next) => {
  try {
    // If branchId is provided, search that branch; otherwise search all branches
    if (req.query.branchId) {
      const tickets = await queueSvc.getBranchQueue(req.query.branchId)
      const ticket = tickets.find((t) => String(t.ticket_number || t.ticketNumber).toUpperCase() === req.params.ticketNumber.toUpperCase())
      if (!ticket) return res.status(404).json({ message: 'Ticket not found or already served.' })
      return res.json({ ticket })
    }

    // Search across all tickets by querying the queues table directly
    const { findMany } = require('../lib/supabaseRepo')
    const allTickets = await findMany('queues', {
      select: '*',
      order: { column: 'created_at', ascending: false },
      limit: 1000, // reasonable limit to avoid fetching too many
    })

    const ticket = allTickets.find((t) => String(t.ticket_number || t.ticketNumber).toUpperCase() === req.params.ticketNumber.toUpperCase())
    if (!ticket) return res.status(404).json({ message: 'Ticket not found or already served.' })
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

module.exports = router
