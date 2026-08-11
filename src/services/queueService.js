const QRCode = require('qrcode')
const { findMany, findById, insert, updateById, allocateNextSequence } = require("../lib/supabaseRepo")
const DEFAULT_SERVICE_DURATION = 20
const TICKET_BLOCK = 999
const LETTERS = 26
const MAX_RETRIES = 5
const toSafeNumber = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
/*
  Queue Service Module
  Provides functions to manage queue tickets, including joining the queue,
  calling the next ticket, marking tickets as served or no-show, transferring tickets,
  and retrieving branch queue and statistics.
*/
function formatTicketNumber(seq) {
  const letter = String.fromCharCode(65 + (Math.floor((seq - 1) / TICKET_BLOCK) % LETTERS))
  const num = String(((seq - 1) % TICKET_BLOCK) + 1).padStart(3, '0')
  return `${letter}${num}`
}
//This is for the maximum retry
async function nextTicketNumber(branchId) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const seq = await allocateNextSequence(branchId)
      return formatTicketNumber(seq)
    } catch (err) {
      if (attempt === 0 && /allocate_queue_sequence/i.test(err?.message || '')) {
        const existing = await findMany('queues', {
          filters: [['branch', 'eq', branchId]],
          select: 'ticket_number',
        })

        const maxSeq = existing.reduce((max, ticket) => {
          const value = String(ticket.ticket_number || ticket.ticketNumber || '')
          const match = value.match(/^([A-Z])(\d{3})$/)
          if (!match) return max
          const letterIndex = match[1].charCodeAt(0) - 65
          const sequence = letterIndex * TICKET_BLOCK + Number(match[2])
          return Number.isFinite(sequence) && sequence > max ? sequence : max
        }, 0)

        return formatTicketNumber(maxSeq + 1)
      }

      if (attempt === MAX_RETRIES - 1) throw err
      // small backoff
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}
// Fetch only needed fields and order by created_at
async function recalculatePositions(branchId) {
  const waiting = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'eq', 'waiting']],
    order: { column: 'created_at', ascending: true },
    select: 'id,service,duration,created_at', // select minimal fields your repo accepts
  })

  // Batch updates could be done in parallel but avoid overwhelming DB
  const updates = waiting.map((row, idx) => {
    const position = idx + 1
    const serviceDuration = toSafeNumber(row.service && row.service.duration, DEFAULT_SERVICE_DURATION)
    const estimated_wait = position * serviceDuration
    return updateById('queues', row.id, { position, estimated_wait })
  })

  await Promise.all(updates)
  return waiting.length
}

async function joinQueue({
  branchId,
  userId = null,
  name,
  email = '',
  phone = '',
  serviceId,
  timeSlot = 'As soon as possible',
  notifyChannel = 'email',
}) {
  if (!branchId || !serviceId || !name) {
    throw Object.assign(new Error('Missing required fields: branchId, serviceId, name'), { statusCode: 400 })
  }

  const branch = await findById('branches', branchId)
  if (!branch) throw Object.assign(new Error('Branch not found.'), { statusCode: 404 })

  const services = await findMany('services', {
    filters: [['branch_id', 'eq', branchId], ['is_active', 'eq', true]],
    order: { column: 'sort_order', ascending: true },
  })

  const service = services
    .map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description || '',
      duration: service.duration ?? DEFAULT_SERVICE_DURATION,
      active: service.is_active !== false,
    }))
    .find((s) => String(s.id) === String(serviceId) && s.active !== false)
  if (!service) throw Object.assign(new Error('Service not available at this branch.'), { statusCode: 400 })

  // allocate ticket number safely
  const ticketNumber = await nextTicketNumber(branchId)

  // compute estimated wait using count query when possible (avoid selecting rows)
  const waiting = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'eq', 'waiting']],
    select: 'id',
  })
  const estimatedWait = (waiting.length + 1) * toSafeNumber(service.duration, DEFAULT_SERVICE_DURATION)

  // generate QR
  const qrCode = await QRCode.toDataURL(JSON.stringify({ ticketNumber, branchId, serviceId }))

  // insert ticket
  const newTicket = {
    ticket_number: ticketNumber,
    branch: branchId,
    user: userId,
    name,
    email,
    phone,
    notify_channel: notifyChannel,
    service: {
      id: service.id,
      name: service.name,
      description: service.description,
      duration: service.duration,
      active: service.is_active,
    },
    time_slot: timeSlot,
    status: 'waiting',
    position: waiting.length + 1,
    estimated_wait: estimatedWait,
    qr_code: qrCode,
    created_at: new Date().toISOString(),
  }

  const inserted = await insert('queues', newTicket)
  return { ...inserted, branch }
}

async function callNext(counterId, branchId) {
  const waiting = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'eq', 'waiting']],
    order: { column: 'created_at', ascending: true },
    limit: 1,
  })

  const nextTicket = waiting && waiting[0]
  if (!nextTicket) return null

  const now = new Date().toISOString()
  const ticket = await updateById('queues', nextTicket.id, {
    status: 'called',
    called_at: now,
    counter: counterId,
  })

  await updateById('counters', counterId, { serving: ticket.id })
  // recalc positions asynchronously 
  await recalculatePositions(branchId)
  return ticket
}

async function markServed(ticketId, counterId) {
  const ticket = await updateById('queues', ticketId, {
    status: 'served',
    served_at: new Date().toISOString(),
  })
  if (counterId) await updateById('counters', counterId, { serving: null })
  if (ticket?.branch) await recalculatePositions(ticket.branch)
  return ticket
}

async function markNoShow(ticketId, counterId) {
  const ticket = await updateById('queues', ticketId, {
    status: 'noshow',
    no_show_at: new Date().toISOString(),
  })
  if (counterId) await updateById('counters', counterId, { serving: null })
  if (ticket?.branch) await recalculatePositions(ticket.branch)
  return ticket
}

async function transferTicket(ticketId, toCounterId) {
  return updateById('queues', ticketId, { counter: toCounterId })
}

async function getBranchQueue(branchId, statusFilter) {
  const filters = [['branch', 'eq', branchId]]
  if (statusFilter) filters.push(['status', 'eq', statusFilter])
  return findMany('queues', { filters, order: { column: 'created_at', ascending: true } })
}

async function getBranchStats(branchId, fromDate) {
  const filters = [['branch', 'eq', branchId]]
  if (fromDate) filters.push(['created_at', 'gte', fromDate.toISOString()])
  const tickets = await findMany('queues', { filters, select: 'status,served_at,no_show_at,created_at' })
  const totalServed = tickets.filter((t) => t.status === 'served').length
  const totalNoShow = tickets.filter((t) => t.status === 'noshow').length
  const totalTickets = tickets.length
  // Optionally calculate avg wait: use served_at - created_at where available
  const servedTickets = tickets.filter((t) => t.status === 'served' && t.served_at && t.created_at)
  const avgWaitTime =
    servedTickets.length > 0
      ? Math.round(
        servedTickets.reduce((acc, t) => acc + (new Date(t.served_at) - new Date(t.created_at)), 0) /
        servedTickets.length /
        1000,
      ) // seconds
      : 0

  return { totalServed, totalNoShow, totalTickets, avgWaitTime }
}

module.exports = {
  joinQueue,
  callNext,
  markServed,
  markNoShow,
  transferTicket,
  getBranchQueue,
  getBranchStats,
  recalculatePositions,
  nextTicketNumber,
}
