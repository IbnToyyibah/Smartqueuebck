const express = require('express')
const { protect, authorize, optionalAuth, requireActiveBranch, requireOwnBranch, canAccessBranch } = require('../middleware/auth')
const branchActiveCheck = require('../middleware/branchActiveCheck')
const queueSvc = require('../services/queueService')
const notifySvc = require('../services/notificationService')
const { findById, findMany, updateById } = require('../lib/supabaseRepo')
const { sameId, toSafeNumber } = require('../utils/common')

const router = express.Router()
const STAFF_ROLES = ['staff', 'branch_admin']
const { ticketNumberOf, toPublicTicket } = queueSvc

const branchIdOf = (ticket) => String(ticket?.branch?.id || ticket?.branch)

const emit = (req, event, ticket) => {
  const io = req.app.get('io')
  if (io && ticket) io.emitToBranch(branchIdOf(ticket), event, ticket)
}

// The ticket owner and the branch's own team see contact details; everyone else gets the public view.
const viewFor = (user, ticket) =>
  (user && (sameId(ticket.user, user.id) || canAccessBranch(user, ticket.branch))) ? ticket : toPublicTicket(ticket)

const notifyTicketHolder = async (ticket, template) => {
  if (!ticket?.user) return
  await notifySvc.notify({
    userId: ticket.user,
    ...template,
    channel: ticket.notify_channel,
    email: ticket.email,
    phone: ticket.phone,
  })
}

// Loads :id and makes sure the acting staff member belongs to the ticket's branch.
const loadBranchTicket = async (req, res, next) => {
  try {
    const ticket = await findById('queues', req.params.id)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    if (!canAccessBranch(req.user, ticket.branch)) {
      return res.status(403).json({ message: 'You can only manage tickets from your own branch.' })
    }
    req.ticket = ticket
    next()
  } catch (err) {
    next(err)
  }
}

// Validates a counter for the acting user: it must exist, be in their branch and,
// for counter agents, be the counter assigned to them.
const resolveCounter = async (req, res, counterId, branchId) => {
  const counter = await findById('counters', counterId)
  if (!counter) {
    res.status(404).json({ message: 'Counter not found.' })
    return null
  }
  if (!sameId(counter.branch, branchId)) {
    res.status(403).json({ message: 'That counter belongs to a different branch.' })
    return null
  }
  if (req.user.role === 'staff' && !sameId(counter.agent, req.user.id)) {
    res.status(403).json({ message: 'You can only serve customers from your assigned counter.' })
    return null
  }
  return counter
}

const staffAction = [protect, authorize(...STAFF_ROLES), requireActiveBranch, loadBranchTicket]

router.post('/join', optionalAuth, branchActiveCheck, async (req, res, next) => {
  try {
    const { branch_id, service_id, time_slot, name, email, phone, notify_channel } = req.body
    if (!String(branch_id || '').trim() || !String(service_id || '').trim() || !String(name || '').trim()) {
      return res.status(400).json({ message: 'branch_id, service_id, and name are required.' })
    }

    const ticket = await queueSvc.joinQueue({
      branchId: branch_id,
      userId: req.user?.id || null,
      name: String(name).trim(),
      email: email || req.user?.email || '',
      phone: phone || req.user?.phone || '',
      serviceId: service_id,
      notifyChannel: notify_channel || req.user?.notify_channel || 'email',
      timeSlot: time_slot,
    })

    emit(req, 'queue:joined', ticket)

    const tpl = notifySvc.templates.ticketConfirmed({
      ticketNumber: ticketNumberOf(ticket),
      estimatedWait: ticket.estimated_wait,
      branchName: ticket.branch?.name || '',
      serviceName: ticket.service?.name || '',
    })
    if (req.user) {
      await notifySvc.notify({
        userId: req.user.id,
        ...tpl,
        channel: ticket.notify_channel,
        email: ticket.email,
        phone: ticket.phone,
      })
    } else if (email) {
      // Guests have no notification record, but still get the confirmation by email.
      const emailResult = await notifySvc.sendEmail({
        to: email,
        subject: `SmartQueue - ${tpl.title}`,
        text: tpl.message,
      })
      if (emailResult.error || emailResult.skipped) {
        console.error(`[notification] Guest ticket email was not sent: ${emailResult.error || 'Email delivery is not configured.'}`)
      }
    }

    res.status(201).json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.get('/my', protect, authorize('customer'), async (req, res, next) => {
  try {
    const [ticket] = await queueSvc.getUserTickets(req.user.id, queueSvc.ACTIVE_STATUSES, 1)
    res.json({ ticket: ticket || null })
  } catch (err) {
    next(err)
  }
})

router.get('/history', protect, authorize('customer'), async (req, res, next) => {
  try {
    const tickets = await queueSvc.getUserTickets(req.user.id, queueSvc.FINISHED_STATUSES, 50)
    res.json({ tickets })
  } catch (err) {
    next(err)
  }
})

router.get('/branch/:branchId', protect, authorize('staff', 'branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const tickets = await queueSvc.getBranchQueue(req.params.branchId, req.query.status)
    res.json({ tickets })
  } catch (err) {
    next(err)
  }
})

// Public, read-only data for lobby displays. Customer contact details stay private.
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
      .filter((ticket) => queueSvc.ACTIVE_STATUSES.includes(ticket.status))
      .map((ticket) => ({
        id: ticket.id,
        ticket_number: ticketNumberOf(ticket),
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

router.get('/stats/:branchId', protect, authorize('branch_admin', 'super_admin'), requireOwnBranch, async (req, res, next) => {
  try {
    const days = Math.min(toSafeNumber(req.query.days, 7) || 7, 365)
    const from = new Date()
    from.setDate(from.getDate() - days)
    const stats = await queueSvc.getBranchStats(req.params.branchId, from)
    res.json({ stats })
  } catch (err) {
    next(err)
  }
})

router.get('/lookup/:ticketNumber', optionalAuth, async (req, res, next) => {
  try {
    const ticketNumber = String(req.params.ticketNumber || '').trim().toUpperCase()
    const filters = [['ticket_number', 'eq', ticketNumber]]
    if (req.query.branchId) filters.push(['branch', 'eq', req.query.branchId])

    // Ticket numbers repeat over time, so prefer the newest active one.
    const matches = await findMany('queues', { filters, order: { column: 'created_at', ascending: false }, limit: 20 })
    const ticket = matches.find((t) => queueSvc.ACTIVE_STATUSES.includes(t.status)) || matches[0]
    if (!ticket) return res.status(404).json({ message: 'Ticket not found or already served.' })
    res.json({ ticket: viewFor(req.user, ticket) })
  } catch (err) {
    next(err)
  }
})

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const ticket = await findById('queues', req.params.id)
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' })
    res.json({ ticket: viewFor(req.user, ticket) })
  } catch (err) {
    next(err)
  }
})

// Calls the next waiting customer to the given counter (the :id segment is kept for API compatibility).
router.post('/:id/call', protect, authorize(...STAFF_ROLES), requireActiveBranch, async (req, res, next) => {
  try {
    const { counter_id } = req.body
    if (!counter_id) return res.status(400).json({ message: 'counter_id required.' })
    const counter = await resolveCounter(req, res, counter_id, req.user.branch)
    if (!counter) return

    const ticket = await queueSvc.callNext(counter.id, counter.branch)
    if (!ticket) return res.status(200).json({ message: 'No customers waiting.', ticket: null })

    emit(req, 'queue:called', ticket)
    await notifyTicketHolder(ticket, notifySvc.templates.ticketCalled({
      ticketNumber: ticketNumberOf(ticket),
      counterName: counter.name || 'the counter',
    }))

    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/serve', ...staffAction, async (req, res, next) => {
  try {
    const { counter_id } = req.body
    if (counter_id && !(await resolveCounter(req, res, counter_id, req.ticket.branch))) return
    const ticket = await queueSvc.markServed(req.ticket, counter_id)
    emit(req, 'queue:served', ticket)
    await notifyTicketHolder(ticket, notifySvc.templates.ticketServed({ ticketNumber: ticketNumberOf(ticket) }))
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/noshow', ...staffAction, async (req, res, next) => {
  try {
    const { counter_id } = req.body
    if (counter_id && !(await resolveCounter(req, res, counter_id, req.ticket.branch))) return
    const ticket = await queueSvc.markNoShow(req.ticket, counter_id)
    emit(req, 'queue:noshow', ticket)
    await notifyTicketHolder(ticket, notifySvc.templates.ticketNoShow({ ticketNumber: ticketNumberOf(ticket) }))
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/transfer', ...staffAction, async (req, res, next) => {
  try {
    const { to_counter_id } = req.body
    if (!to_counter_id) return res.status(400).json({ message: 'to_counter_id required.' })
    const target = await findById('counters', to_counter_id)
    if (!target || !sameId(target.branch, req.ticket.branch)) {
      return res.status(400).json({ message: 'Target counter must belong to the same branch.' })
    }
    const ticket = await queueSvc.transferTicket(req.ticket, target.id)
    emit(req, 'queue:transferred', ticket)
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/skip', ...staffAction, async (req, res, next) => {
  try {
    const ticket = await queueSvc.skipTicket(req.ticket)
    emit(req, 'queue:skipped', ticket)
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/recall', ...staffAction, async (req, res, next) => {
  try {
    const ticket = await queueSvc.recallTicket(req.ticket)
    emit(req, 'queue:called', ticket)
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

// Check-in is done by the ticket holder or by the branch's own team.
router.post('/:id/checkin', protect, async (req, res, next) => {
  try {
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc) return res.status(404).json({ message: 'Ticket not found.' })
    if (!sameId(ticketDoc.user, req.user.id) && !canAccessBranch(req.user, ticketDoc.branch)) {
      return res.status(403).json({ message: 'You can only check in your own ticket.' })
    }
    const ticket = await queueSvc.checkInTicket(ticketDoc)
    emit(req, 'queue:checkedin', ticket)
    res.json({ ticket: viewFor(req.user, ticket) })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id/rate', protect, authorize('customer'), async (req, res, next) => {
  try {
    const rating = Number(req.body.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be a whole number from 1 to 5.' })
    }
    const ticketDoc = await findById('queues', req.params.id)
    if (!ticketDoc || !sameId(ticketDoc.user, req.user.id) || ticketDoc.status !== 'served') {
      return res.status(404).json({ message: 'Ticket not found or not eligible for rating.' })
    }
    const ticket = await updateById('queues', ticketDoc.id, { rating })
    res.json({ ticket })
  } catch (err) {
    next(err)
  }
})

module.exports = router
