/*
  Queue Service Module
  Ticket lifecycle for a branch queue: join, call, serve, no-show, skip, recall,
  transfer, plus position recalculation and branch statistics.
*/
const QRCode = require('qrcode')
const { findMany, findById, insert, updateById, allocateNextSequence } = require('../lib/supabaseRepo')
const { toSafeNumber, httpError, sameId } = require('../utils/common')

const DEFAULT_SERVICE_DURATION = 20
const TICKET_BLOCK = 999
const LETTERS = 26
const MAX_RETRIES = 5

// Checked-in customers are still in line; they just confirmed they are on site.
const WAITING_STATUSES = ['waiting', 'checked_in']
const AT_COUNTER_STATUSES = ['called', 'serving']
const ACTIVE_STATUSES = [...WAITING_STATUSES, ...AT_COUNTER_STATUSES]
const FINISHED_STATUSES = ['served', 'noshow', 'cancelled']

const ticketNumberOf = (ticket) => ticket?.ticket_number || ticket?.ticketNumber

// Fields safe to show anyone who knows the ticket id/number (lobby screens, public tracking).
const toPublicTicket = (ticket) => {
  if (!ticket) return null
  const service = typeof ticket.service === 'string' ? safeParse(ticket.service) : ticket.service
  return {
    id: ticket.id,
    ticket_number: ticketNumberOf(ticket),
    branch: ticket.branch?.id || ticket.branch,
    status: ticket.status,
    position: ticket.position,
    estimated_wait: ticket.estimated_wait,
    service: service ? { id: service.id, name: service.name || service.label, duration: service.duration } : null,
    counter: ticket.counter || null,
    time_slot: ticket.time_slot,
    called_at: ticket.called_at || null,
    served_at: ticket.served_at || null,
    created_at: ticket.created_at,
  }
}

const safeParse = (value) => {
  try { return JSON.parse(value) } catch { return null }
}

function formatTicketNumber(seq) {
  const letter = String.fromCharCode(65 + (Math.floor((seq - 1) / TICKET_BLOCK) % LETTERS))
  const num = String(((seq - 1) % TICKET_BLOCK) + 1).padStart(3, '0')
  return `${letter}${num}`
}

async function nextTicketNumber(branchId) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const seq = await allocateNextSequence(branchId)
      return formatTicketNumber(seq)
    } catch (err) {
      // The database function is missing: fall back to scanning existing tickets.
      if (attempt === 0 && /allocate_queue_sequence/i.test(err?.message || '')) {
        const existing = await findMany('queues', {
          filters: [['branch', 'eq', branchId]],
          select: 'ticket_number',
        })

        const maxSeq = existing.reduce((max, ticket) => {
          const match = String(ticketNumberOf(ticket) || '').match(/^([A-Z])(\d{3})$/)
          if (!match) return max
          const sequence = (match[1].charCodeAt(0) - 65) * TICKET_BLOCK + Number(match[2])
          return Number.isFinite(sequence) && sequence > max ? sequence : max
        }, 0)

        return formatTicketNumber(maxSeq + 1)
      }

      if (attempt === MAX_RETRIES - 1) throw err
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}

const getWaiting = (branchId, select = '*') =>
  findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'in', WAITING_STATUSES]],
    order: { column: 'created_at', ascending: true },
    select,
  })

async function recalculatePositions(branchId) {
  const waiting = await getWaiting(branchId, 'id,service,position,estimated_wait')

  // Wait is the sum of the service durations ahead of (and including) each ticket.
  let elapsed = 0
  const updates = []
  waiting.forEach((row, idx) => {
    const position = idx + 1
    elapsed += toSafeNumber(row.service?.duration, DEFAULT_SERVICE_DURATION)
    if (row.position !== position || row.estimated_wait !== elapsed) {
      updates.push(updateById('queues', row.id, { position, estimated_wait: elapsed }))
    }
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
    throw httpError(400, 'Missing required fields: branchId, serviceId, name')
  }

  const branch = await findById('branches', branchId)
  if (!branch) throw httpError(404, 'Branch not found.')

  const service = await findById('services', serviceId)
  if (!service || !sameId(service.branch_id, branchId) || service.is_active === false) {
    throw httpError(400, 'Service not available at this branch.')
  }

  const ticketNumber = await nextTicketNumber(branchId)
  const waiting = await getWaiting(branchId, 'id,service')
  const duration = toSafeNumber(service.duration, DEFAULT_SERVICE_DURATION)
  const estimatedWait = waiting.reduce(
    (sum, row) => sum + toSafeNumber(row.service?.duration, DEFAULT_SERVICE_DURATION),
    duration
  )

  const qrCode = await QRCode.toDataURL(JSON.stringify({ ticketNumber, branchId, serviceId }))

  const inserted = await insert('queues', {
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
      description: service.description || '',
      duration,
      active: true,
    },
    time_slot: timeSlot,
    status: 'waiting',
    position: waiting.length + 1,
    estimated_wait: estimatedWait,
    qr_code: qrCode,
    created_at: new Date().toISOString(),
  })
  return { ...inserted, branch }
}

async function callNext(counterId, branchId) {
  const [nextTicket] = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'in', WAITING_STATUSES]],
    order: { column: 'created_at', ascending: true },
    limit: 1,
  })
  if (!nextTicket) return null

  const ticket = await updateById('queues', nextTicket.id, {
    status: 'called',
    called_at: new Date().toISOString(),
    counter: counterId,
  })

  await updateById('counters', counterId, { serving: ticket.id })
  await recalculatePositions(branchId)
  return ticket
}

async function finishTicket(ticket, status, timestampField, counterId) {
  if (!AT_COUNTER_STATUSES.includes(ticket.status)) {
    throw httpError(409, `Ticket ${ticketNumberOf(ticket)} is ${ticket.status}; only called tickets can be closed.`)
  }
  const updated = await updateById('queues', ticket.id, {
    status,
    [timestampField]: new Date().toISOString(),
  })
  const counter = counterId || ticket.counter
  if (counter) await updateById('counters', counter, { serving: null })
  await recalculatePositions(ticket.branch)
  return updated
}

const markServed = (ticket, counterId) => finishTicket(ticket, 'served', 'served_at', counterId)
const markNoShow = (ticket, counterId) => finishTicket(ticket, 'noshow', 'no_show_at', counterId)

// Sends a waiting/called customer to the back of the line.
async function skipTicket(ticket) {
  if (!ACTIVE_STATUSES.includes(ticket.status)) {
    throw httpError(409, `Ticket ${ticketNumberOf(ticket)} is ${ticket.status} and cannot be skipped.`)
  }
  if (ticket.counter) await updateById('counters', ticket.counter, { serving: null })
  // The queue is ordered by created_at, so re-stamping it moves the ticket to the end.
  const updated = await updateById('queues', ticket.id, {
    status: 'waiting',
    counter: null,
    called_at: null,
    created_at: new Date().toISOString(),
  })
  await recalculatePositions(ticket.branch)
  return findById('queues', updated.id)
}

async function recallTicket(ticket) {
  if (!AT_COUNTER_STATUSES.includes(ticket.status)) {
    throw httpError(409, `Ticket ${ticketNumberOf(ticket)} is ${ticket.status}; only called tickets can be recalled.`)
  }
  return updateById('queues', ticket.id, { status: 'called', called_at: new Date().toISOString() })
}

async function checkInTicket(ticket) {
  if (ticket.status !== 'waiting') {
    throw httpError(409, `Ticket ${ticketNumberOf(ticket)} is ${ticket.status} and cannot be checked in.`)
  }
  return updateById('queues', ticket.id, { status: 'checked_in' })
}

async function transferTicket(ticket, toCounterId) {
  const updated = await updateById('queues', ticket.id, { counter: toCounterId })
  if (AT_COUNTER_STATUSES.includes(ticket.status)) {
    if (ticket.counter) await updateById('counters', ticket.counter, { serving: null })
    await updateById('counters', toCounterId, { serving: ticket.id })
  }
  return updated
}

async function getBranchQueue(branchId, statusFilter) {
  const filters = [['branch', 'eq', branchId]]
  if (statusFilter) filters.push(['status', 'eq', statusFilter])
  return findMany('queues', { filters, order: { column: 'created_at', ascending: true } })
}

async function getUserTickets(userId, statuses, limit = 50) {
  return findMany('queues', {
    filters: [['user', 'eq', userId], ['status', 'in', statuses]],
    order: { column: 'created_at', ascending: false },
    limit,
  })
}

// Minutes between joining and being called (falls back to served time).
const waitMinutes = (t) => {
  const end = t.called_at || t.served_at
  if (!end || !t.created_at) return null
  const minutes = (new Date(end) - new Date(t.created_at)) / 60000
  return minutes >= 0 ? minutes : null
}

const average = (values) => {
  const nums = values.filter((v) => typeof v === 'number')
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

function summarize(tickets) {
  const served = tickets.filter((t) => t.status === 'served')
  const ratings = served.map((t) => toSafeNumber(t.rating, null)).filter((r) => r)
  return {
    served: served.length,
    noShow: tickets.filter((t) => t.status === 'noshow').length,
    waiting: tickets.filter((t) => WAITING_STATUSES.includes(t.status)).length,
    total: tickets.length,
    avgWait: Math.round(average(served.map(waitMinutes)) * 10) / 10,
    avgRating: ratings.length ? Math.round(average(ratings) * 10) / 10 : null,
  }
}

const groupBy = (items, keyFn) =>
  items.reduce((map, item) => {
    const key = keyFn(item)
    if (key === null || key === undefined) return map
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
    return map
  }, new Map())

async function getTicketsSince(branchId, fromDate) {
  const filters = [['created_at', 'gte', fromDate.toISOString()]]
  if (branchId) filters.unshift(['branch', 'eq', branchId])
  return findMany('queues', {
    filters,
    select: 'branch,status,service,rating,created_at,called_at,served_at,no_show_at',
  })
}

async function getBranchStats(branchId, fromDate) {
  const s = summarize(await getTicketsSince(branchId, fromDate))
  return {
    totalServed: s.served,
    totalNoShow: s.noShow,
    totalTickets: s.total,
    avgWaitTime: s.avgWait, // minutes
  }
}

async function getBranchAnalytics(branchId, fromDate) {
  const tickets = await getTicketsSince(branchId, fromDate)
  const totals = summarize(tickets)

  const daily = [...groupBy(tickets, (t) => t.created_at?.slice(0, 10))]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, rows]) => ({ _id: day, ...summarize(rows) }))

  const hourly = [...groupBy(tickets, (t) => (t.created_at ? new Date(t.created_at).getHours() : null))]
    .sort(([a], [b]) => a - b)
    .map(([hour, rows]) => ({ _id: hour, ...summarize(rows) }))

  const services = [...groupBy(tickets, (t) => t.service?.id || t.service?.name || null)]
    .map(([id, rows]) => ({ _id: id, label: rows[0].service?.name || id, ...summarize(rows) }))
    .sort((a, b) => b.served - a.served)

  return {
    daily,
    hourly,
    services,
    totals: {
      totalServed: totals.served,
      totalNoShow: totals.noShow,
      totalTickets: totals.total,
      avgWaitTime: totals.avgWait,
    },
  }
}

async function getPlatformAnalytics(fromDate) {
  const tickets = await getTicketsSince(null, fromDate)
  return [...groupBy(tickets, (t) => t.branch)].map(([branch, rows]) => ({ _id: branch, ...summarize(rows) }))
}

module.exports = {
  WAITING_STATUSES,
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  ticketNumberOf,
  toPublicTicket,
  joinQueue,
  callNext,
  markServed,
  markNoShow,
  skipTicket,
  recallTicket,
  checkInTicket,
  transferTicket,
  getBranchQueue,
  getUserTickets,
  getBranchStats,
  getBranchAnalytics,
  getPlatformAnalytics,
  recalculatePositions,
  nextTicketNumber,
}
