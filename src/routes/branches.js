const express = require('express')
const { protect, authorize, requireActiveBranch } = require('../middleware/auth')
const { findMany, findById, insert, updateById, deleteById } = require('../lib/supabaseRepo')

const router = express.Router()

const DEFAULT_HOURS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
  (day) => ({ day, open: day !== 'Sunday', from: '08:00', to: '17:00' })
)

const DEFAULT_SERVICES = [
  { id: 'general', name: 'General Inquiry', duration: 8, active: true },
  { id: 'account', name: 'Account Services', duration: 12, active: true },
  { id: 'loans', name: 'Loans & Credit', duration: 20, active: true },
  { id: 'consultation', name: 'Medical Consultation', duration: 15, active: true },
  { id: 'document', name: 'Document Processing', duration: 10, active: true },
  { id: 'complaints', name: 'Complaints & Feedback', duration: 10, active: true },
]

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

router.post('/', protect, authorize('branch_admin', 'super_admin'), async (req, res, next) => {
  try {
    const { name, city, address, phone, email, max_capacity, category, billing_details } = req.body
    if (!name || !city || !address) return res.status(400).json({ message: 'name, city, address are required.' })
    const branch = await insert('branches', {
      name, city, address,
      phone: phone || '',
      email: email || '',
      category: category || 'other',
      max_capacity: max_capacity || 150,
      subscription_status: req.user.role === 'branch_admin' ? 'trial' : 'active',
      operating_hours: DEFAULT_HOURS,
      services: DEFAULT_SERVICES,
      ...(billing_details ? { billing_details } : {}),
    })
    res.status(201).json({ branch })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const updates = {}
    ;['name', 'city', 'address', 'phone', 'email', 'max_capacity', 'status', 'category', 'operating_hours', 'services', 'notifications', 'billing_details'].forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f]
    })
    const branch = await updateById('branches', req.params.id, updates)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })
    res.json({ branch })
  } catch (err) { next(err) }
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

router.get('/:id/counters', protect, requireActiveBranch, async (req, res, next) => {
  try {
    const counters = await findMany('counters', { filters: [['branch', 'eq', req.params.id]] })
    res.json({ counters })
  } catch (err) { next(err) }
})

module.exports = router
