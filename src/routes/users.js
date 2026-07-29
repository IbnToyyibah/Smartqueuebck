const express = require('express')
const bcrypt = require('bcryptjs')
const { protect, authorize, requireActiveBranch } = require('../middleware/auth')
const { findMany, insert, findById, updateById, deleteById } = require('../lib/supabaseRepo')

const router = express.Router()

const safeUser = (user) => {
  if (!user) return null
  const copy = { ...user }
  delete copy.password
  return copy
}

router.get('/', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const filters = []
    if (req.query.role) filters.push(['role', 'eq', req.query.role])
    if (req.query.status) filters.push(['status', 'eq', req.query.status])
    if (req.query.branch) filters.push(['branch', 'eq', req.query.branch])
    const users = await findMany('users', { filters, order: { column: 'created_at', ascending: false } })
    res.json({ users: users.map(safeUser) })
  } catch (err) { next(err) }
})

router.get('/branch/:branchId', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const users = await findMany('users', {
      filters: [['branch', 'eq', req.params.branchId], ['role', 'eq', 'staff']],
    })
    res.json({ users: users.map(safeUser) })
  } catch (err) { next(err) }
})

router.post('/', protect, authorize('super_admin', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const { name, email, password, phone, role, branch, notify_channel, status } = req.body
    if (!name || !email || !password) return res.status(400).json({ message: 'name, email, password are required.' })
    const assignedBranch = req.user.role === 'branch_admin' ? req.user.branch : branch
    const assignedRole = req.user.role === 'branch_admin' ? 'staff' : (role || 'staff')
    if (!assignedBranch) return res.status(400).json({ message: 'A branch is required to create a counter agent.' })
    const hashed = await bcrypt.hash(password, 12)
    const user = await insert('users', {
      name, email, password: hashed, phone: phone || '',
      role: assignedRole,
      branch: assignedBranch,
      notify_channel: notify_channel || 'email',
      status: ['active', 'suspended'].includes(status) ? status : 'active',
    })
    res.status(201).json({ user: safeUser(user) })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('super_admin', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const allowed = ['name', 'phone', 'role', 'branch', 'status', 'notify_channel']
    const updates = {}
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    if (req.user.role === 'branch_admin') {
      delete updates.role
      delete updates.branch
      const target = await findById('users', req.params.id)
      if (!target) return res.status(404).json({ message: 'User not found.' })
      if (target.role !== 'staff' || String(target.branch) !== String(req.user.branch)) {
        return res.status(403).json({ message: 'You can only manage counter agents for your own branch.' })
      }
    }
    const user = await updateById('users', req.params.id, updates)
    if (!user) return res.status(404).json({ message: 'User not found.' })
    res.json({ user: safeUser(user) })
  } catch (err) { next(err) }
})

router.delete('/:id', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    await deleteById('users', req.params.id)
    res.json({ message: 'User removed.' })
  } catch (err) { next(err) }
})

module.exports = router
