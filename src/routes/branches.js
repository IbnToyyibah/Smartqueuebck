const express = require('express')
const { protect, authorize, optionalAuth, requireActiveBranch, ownBranch, canAccessBranch } = require('../middleware/auth')
const { findMany, findById, insert, updateById, updateWhere, deleteById, deleteWhere } = require('../lib/supabaseRepo')
const { getSeedServicesForBranch } = require('../utils/serviceCatalog')
const { DEFAULT_HOURS, toSafeNumber, seedServices } = require('../utils/common')

const router = express.Router()
// On /branches/:id routes the :id param *is* the branch id.
const requireOwnBranchById = ownBranch('id')
const requireOwnBranch = ownBranch('branchId')

const mapServiceRow = (service) => ({
  ...service,
  branchId: service.branch_id,
  isActive: service.is_active,
})

// Gives branches created before services were stored per-branch a starter catalogue.
const ensureBranchServices = async (branch) => {
  const existing = await findMany('services', {
    filters: [['branch_id', 'eq', branch.id]],
    order: { column: 'sort_order', ascending: true },
  })
  if (existing.length > 0) return existing

  await seedServices(branch.id, getSeedServicesForBranch(branch))
  return findMany('services', {
    filters: [['branch_id', 'eq', branch.id]],
    order: { column: 'sort_order', ascending: true },
  })
}

// Loads :serviceId and checks it belongs to the acting admin's branch.
const loadService = async (req, res, next) => {
  try {
    const service = await findById('services', req.params.serviceId)
    if (!service) return res.status(404).json({ message: 'Service not found.' })
    if (!canAccessBranch(req.user, service.branch_id)) {
      return res.status(403).json({ message: 'You can only manage services for your own branch.' })
    }
    req.service = service
    next()
  } catch (err) { next(err) }
}

// Billing details are only shown to a super admin or the branch's own admin.
const branchViewFor = (user, branch) => {
  const canSeeBilling = user?.role === 'super_admin' || (user?.role === 'branch_admin' && canAccessBranch(user, branch.id))
  if (canSeeBilling) return branch
  const { billing_details, ...rest } = branch
  return rest
}

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const filters = [['status', 'neq', 'offline']]
    if (req.query.category) filters.push(['category', 'eq', req.query.category])
    const branches = await findMany('branches', { filters, order: { column: 'created_at', ascending: false } })
    res.json({ branches: branches.map((b) => branchViewFor(req.user, b)) })
  } catch (err) { next(err) }
})

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const branch = await findById('branches', req.params.id)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    res.json({ branch: branchViewFor(req.user, branch) })
  } catch (err) { next(err) }
})

router.get('/:branchId/services', async (req, res, next) => {
  try {
    const branch = await findById('branches', req.params.branchId)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    const services = await ensureBranchServices(branch)
    res.json({ services: services.map(mapServiceRow) })
  } catch (err) {
    next(err)
  }
})

// Branch admins get their branch at registration; additional branches are provisioned by a super admin.
router.post('/', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const { name, city, address, phone, email, max_capacity, category, billing_details } = req.body
    if (!name || !city || !address) return res.status(400).json({ message: 'name, city, address are required.' })
    const branch = await insert('branches', {
      name, city, address,
      phone: phone || '',
      email: email || '',
      category: category || 'other',
      max_capacity: toSafeNumber(max_capacity, 150),
      subscription_status: 'active',
      operating_hours: DEFAULT_HOURS,
      ...(billing_details ? { billing_details } : {}),
    })
    await seedServices(branch.id, getSeedServicesForBranch(branch))
    res.status(201).json({ branch })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranchById, async (req, res, next) => {
  try {
    const updates = {}
    ;['name', 'city', 'address', 'phone', 'email', 'max_capacity', 'status', 'category', 'operating_hours', 'notifications'].forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f]
    })
    if (updates.max_capacity !== undefined) updates.max_capacity = toSafeNumber(updates.max_capacity, 150)
    // Only the platform owner edits stored billing details.
    if (req.user.role === 'super_admin' && req.body.billing_details !== undefined) {
      updates.billing_details = req.body.billing_details
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Nothing to update.' })
    }
    const branch = await updateById('branches', req.params.id, updates)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    res.json({ branch })
  } catch (err) { next(err) }
})

router.post('/:branchId/services', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const { name, description, duration, is_active, sort_order } = req.body
    if (!name) return res.status(400).json({ message: 'name is required.' })
    const service = await insert('services', {
      branch_id: req.params.branchId,
      name,
      description: description || '',
      duration: toSafeNumber(duration, 10),
      is_active: is_active !== false,
      sort_order: toSafeNumber(sort_order, 0),
      meta: {},
    })
    res.status(201).json({ service: mapServiceRow(service) })
  } catch (err) {
    next(err)
  }
})

router.patch('/services/:serviceId', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, loadService, async (req, res, next) => {
  try {
    const updates = {}
    ;['name', 'description', 'duration', 'is_active', 'sort_order', 'meta'].forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f]
    })
    const updated = await updateById('services', req.service.id, updates)
    res.json({ service: mapServiceRow(updated) })
  } catch (err) {
    next(err)
  }
})

router.delete('/services/:serviceId', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, loadService, async (req, res, next) => {
  try {
    await deleteById('services', req.service.id)
    res.json({ message: 'Service removed.' })
  } catch (err) {
    next(err)
  }
})

// Rows in other tables point at the branch, so remove or detach them first;
// otherwise Postgres rejects the delete with a foreign-key violation.
router.delete('/:id', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const branchId = req.params.id
    const branch = await findById('branches', branchId, 'id')
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })

    const tickets = await findMany('queues', { select: 'id', filters: [['branch', 'eq', branchId]] })
    const ticketIds = tickets.map((t) => t.id)
    if (ticketIds.length) {
      await updateWhere('counters', [['branch', 'eq', branchId]], { serving: null })
      for (let i = 0; i < ticketIds.length; i += 200) {
        await deleteWhere('notifications', [['ticket', 'in', ticketIds.slice(i, i + 200)]])
      }
    }
    await deleteWhere('queues', [['branch', 'eq', branchId]])
    await deleteWhere('counters', [['branch', 'eq', branchId]])
    await deleteWhere('services', [['branch_id', 'eq', branchId]])
    await deleteWhere('branch_queue_sequences', [['branch_id', 'eq', branchId]])
    // Staff and branch admins lose their workplace: detach and suspend rather than delete accounts.
    await updateWhere('users', [['branch', 'eq', branchId]], { branch: null, status: 'suspended' })

    await deleteById('branches', branchId)
    res.json({ message: 'Branch removed.' })
  } catch (err) { next(err) }
})

router.patch('/:id/subscription', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const updates = {}
    const toIso = (value) => {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? null : date.toISOString()
    }
    // The admin UI sends camelCase (subscriptionStatus); accept both spellings.
    const subscriptionStatus = req.body.subscription_status ?? req.body.subscriptionStatus
    if (subscriptionStatus) {
      if (!['trial', 'active', 'expired', 'suspended'].includes(subscriptionStatus)) {
        return res.status(400).json({ message: 'Invalid subscription_status.' })
      }
      updates.subscription_status = subscriptionStatus
    }
    for (const [field, camel] of [['subscription_end_date', 'subscriptionEndDate'], ['trial_end_date', 'trialEndDate']]) {
      const value = req.body[field] ?? req.body[camel]
      if (!value) continue
      const iso = toIso(value)
      if (!iso) return res.status(400).json({ message: `${field} is not a valid date.` })
      updates[field] = iso
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Nothing to update.' })
    }
    const branch = await updateById('branches', req.params.id, updates)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    res.json({ branch })
  } catch (err) { next(err) }
})

router.get('/:id/counters', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranchById, async (req, res, next) => {
  try {
    const counters = await findMany('counters', { filters: [['branch', 'eq', req.params.id]] })
    res.json({ counters })
  } catch (err) { next(err) }
})

module.exports = router
