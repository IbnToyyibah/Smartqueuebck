const express = require('express')
const { protect, authorize, requireActiveBranch, requireOwnBranch } = require('../middleware/auth')
const { findMany, findById, insert, updateById, deleteById } = require('../lib/supabaseRepo')
const { DEFAULT_SERVICES, getSeedServicesForBranch, normalizeServices } = require('../utils/serviceCatalog')

const router = express.Router()
const toSafeNumber = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const DEFAULT_HOURS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
  (day) => ({ day, open: day !== 'Sunday', from: '08:00', to: '17:00' })
)

const mapServiceRow = (service) => ({
  ...service,
  id: service.id || service._id,
  branchId: service.branch_id,
  isActive: service.is_active,
})

const syncBranchServices = async (branch) => {
  const source = getSeedServicesForBranch(branch)
  if (!source.length) return []

  const existing = await findMany('services', {
    filters: [['branch_id', 'eq', branch.id]],
  })

  if (existing.length > 0) return existing

  await Promise.all(
    source.map((service, index) =>
      insert('services', {
        branch_id: branch.id,
        name: service.name,
        description: service.description,
        duration: service.duration,
        is_active: service.is_active,
        sort_order: service.sort_order ?? index,
        meta: service.meta || {},
      })
    )
  )

  return findMany('services', {
    filters: [['branch_id', 'eq', branch.id]],
    order: { column: 'sort_order', ascending: true },
  })
}

const seedDefaultServices = async (branchId, services = DEFAULT_SERVICES) => {
  for (let i = 0; i < services.length; i += 1) {
    const service = services[i]
    await insert('services', {
      branch_id: branchId,
      name: service.name,
      description: service.description || '',
      duration: service.duration ?? 10,
      is_active: service.active !== false,
      sort_order: i,
      meta: {},
    })
  }
}

router.get('/', async (req, res, next) => {
  try {
    const filters = [['status', 'neq', 'offline']]
    if (req.query.category) filters.push(['category', 'eq', req.query.category])
    const branches = await findMany('branches', { filters, order: { column: 'created_at', ascending: false } })
    res.json({ branches })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const branch = await findById('branches', req.params.id)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    res.json({ branch })
  } catch (err) { next(err) }
})

router.get('/:branchId/services', async (req, res, next) => {
  try {
    const branch = await findById('branches', req.params.branchId)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    const services = await syncBranchServices(branch)
    res.json({ services: services.map(mapServiceRow) })
  } catch (err) {
    next(err)
  }
})

router.post('/', protect, authorize('branch_admin', 'super_admin'), async (req, res, next) => {
  try {
    const { name, city, address, phone, email, max_capacity, category, billing_details } = req.body
    if (!name || !city || !address) return res.status(400).json({ message: 'name, city, address are required.' })
    const branch = await insert('branches', {
      name, city, address,
      phone: phone || '',
      email: email || '',
      category: category || 'other',
      max_capacity: toSafeNumber(max_capacity, 150),
      subscription_status: req.user.role === 'branch_admin' ? 'trial' : 'active',
      operating_hours: DEFAULT_HOURS,
      ...(billing_details ? { billing_details } : {}),
    })
    await seedDefaultServices(branch.id)
    res.status(201).json({ branch })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const updates = {}
    ;['name', 'city', 'address', 'phone', 'email', 'max_capacity', 'status', 'category', 'operating_hours', 'notifications', 'billing_details'].forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f]
    })
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

router.patch('/services/:serviceId', protect, authorize('branch_admin', 'super_admin'), requireOwnBranch, async (req, res, next) => {
  try {
    const service = await findById('services', req.params.serviceId)
    if (!service) return res.status(404).json({ message: 'Service not found.' })
    if (req.user.role === 'branch_admin' && String(service.branch_id) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only manage services for your own branch.' })
    }
    const updates = {}
    ;['name', 'description', 'duration', 'is_active', 'sort_order', 'meta'].forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f]
    })
    const updated = await updateById('services', req.params.serviceId, updates)
    if (!updated) return res.status(404).json({ message: 'Service not found.' })
    res.json({ service: mapServiceRow(updated) })
  } catch (err) {
    next(err)
  }
})

router.delete('/services/:serviceId', protect, authorize('branch_admin', 'super_admin'), requireOwnBranch, async (req, res, next) => {
  try {
    const service = await findById('services', req.params.serviceId)
    if (!service) return res.status(404).json({ message: 'Service not found.' })
    if (req.user.role === 'branch_admin' && String(service.branch_id) !== String(req.user.branch)) {
      return res.status(403).json({ message: 'You can only manage services for your own branch.' })
    }
    await deleteById('services', req.params.serviceId)
    res.json({ message: 'Service removed.' })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    await deleteById('branches', req.params.id)
    res.json({ message: 'Branch removed.' })
  } catch (err) { next(err) }
})

router.patch('/:id/subscription', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const updates = {}
    if (req.body.subscription_status) updates.subscription_status = req.body.subscription_status
    if (req.body.subscription_end_date) updates.subscription_end_date = new Date(req.body.subscription_end_date).toISOString()
    if (req.body.trial_end_date) updates.trial_end_date = new Date(req.body.trial_end_date).toISOString()
    const branch = await updateById('branches', req.params.id, updates)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    res.json({ branch })
  } catch (err) { next(err) }
})

router.get('/:id/counters', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const counters = await findMany('counters', { filters: [['branch', 'eq', req.params.id]] })
    res.json({ counters })
  } catch (err) { next(err) }
})

module.exports = router
