const QRCode = require('qrcode')
const { findMany, findById, insert, updateById } = require('../lib/supabaseRepo')

const nextTicketNumber = async (branchId) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tickets = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['created_at', 'gte', today.toISOString()]],
    select: 'id',
  })
  const count = tickets.length
  const letter = String.fromCharCode(65 + (Math.floor(count / 999) % 26))
  const num = String((count % 999) + 1).padStart(3, '0')
  return `${letter}${num}`
}

const recalculatePositions = async (branchId) => {
  const waiting = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'eq', 'waiting']],
    order: { column: 'created_at', ascending: true },
  })
  for (let i = 0; i < waiting.length; i += 1) {
    await updateById('queues', waiting[i].id, {
      position: i + 1,
      estimated_wait: (i + 1) * ((waiting[i].service?.duration) || 10),
    })
  }
  return waiting.length
}

const joinQueue = async ({ branchId, userId, name, email, phone, serviceId, timeSlot, notifyChannel }) => {
  const branch = await findById('branches', branchId)
  if (!branch) throw Object.assign(new Error('Branch not found.'), { statusCode: 404 })
  const services = branch.services || branch.services_json || []
  const service = services.find((s) => s.id === serviceId && s.active)
  if (!service) throw Object.assign(new Error('Service not available at this branch.'), { statusCode: 400 })

  const ticketNumber = await nextTicketNumber(branchId)
  const waiting = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'eq', 'waiting']],
    select: 'id',
  })
  const estimatedWait = (waiting.length + 1) * (service.duration || 10)
  const qrCode = await QRCode.toDataURL(JSON.stringify({ ticketNumber, branchId, serviceId }))

  const ticket = await insert('queues', {
    ticket_number: ticketNumber,
    branch: branchId,
    user: userId || null,
    name,
    email: email || '',
    phone: phone || '',
    notify_channel: notifyChannel || 'email',
    service,
    time_slot: timeSlot || 'As soon as possible',
    status: 'waiting',
    position: waiting.length + 1,
    estimated_wait: estimatedWait,
    qr_code: qrCode,
  })

  return { ...ticket, branch }
}

const callNext = async (counterId, branchId) => {
  const waiting = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ['status', 'eq', 'waiting']],
    order: { column: 'created_at', ascending: true },
    limit: 1,
  })
  const nextTicket = waiting[0]
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

const markServed = async (ticketId, counterId) => {
  const ticket = await updateById('queues', ticketId, {
    status: 'served',
    served_at: new Date().toISOString(),
  })
  if (counterId) await updateById('counters', counterId, { serving: null })
  if (ticket?.branch) await recalculatePositions(ticket.branch)
  return ticket
}

const markNoShow = async (ticketId, counterId) => {
  const ticket = await updateById('queues', ticketId, {
    status: 'noshow',
    no_show_at: new Date().toISOString(),
  })
  if (counterId) await updateById('counters', counterId, { serving: null })
  if (ticket?.branch) await recalculatePositions(ticket.branch)
  return ticket
}

const transferTicket = async (ticketId, toCounterId) => updateById('queues', ticketId, { counter: toCounterId })

const getBranchQueue = async (branchId, statusFilter) => {
  const filters = [['branch', 'eq', branchId]]
  if (statusFilter) filters.push(['status', 'eq', statusFilter])
  return findMany('queues', { filters, order: { column: 'created_at', ascending: true } })
}

const getBranchStats = async (branchId, fromDate) => {
  const tickets = await findMany('queues', {
    filters: [['branch', 'eq', branchId], ...(fromDate ? [['created_at', 'gte', fromDate.toISOString()]] : [])],
  })
  const totalServed = tickets.filter((t) => t.status === 'served').length
  const totalNoShow = tickets.filter((t) => t.status === 'noshow').length
  const totalTickets = tickets.length
  return { totalServed, totalNoShow, totalTickets, avgWaitTime: 0 }
}

module.exports = { joinQueue, callNext, markServed, markNoShow, transferTicket, getBranchQueue, getBranchStats, recalculatePositions, nextTicketNumber }
