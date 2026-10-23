const express = require('express')
const bcrypt = require('bcryptjs')
const { protect, authorize, requireActiveBranch, requireOwnBranch } = require('../middleware/auth')
const { findMany, insert, findById, updateById, deleteById } = require('../lib/supabaseRepo')
const { safeUser, normalizeEmail, sameId } = require('../utils/common')

const router = express.Router()
const ROLES = ['customer', 'staff', 'branch_admin', 'super_admin']
const STATUSES = ['active', 'suspended']

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

router.get('/branch/:branchId', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const users = await findMany('users', {
      filters: [['branch', 'eq', req.params.branchId], ['role', 'eq', 'staff']],
    })
    res.json({ users: users.map(safeUser) })
  } catch (err) { next(err) }
})

router.post('/', protect, authorize('super_admin', 'branch_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const { name, password, phone, role, branch, notify_channel, status } = req.body
    const email = normalizeEmail(req.body.email)
    if (!name || !email || !password) return res.status(400).json({ message: 'name, email, password are required.' })
    if (String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' })

    const isBranchAdmin = req.user.role === 'branch_admin'
    const assignedRole = isBranchAdmin ? 'staff' : (role || 'staff')
    if (!ROLES.includes(assignedRole)) return res.status(400).json({ message: 'Invalid role.' })
    const assignedBranch = isBranchAdmin ? req.user.branch : branch
    if (['staff', 'branch_admin'].includes(assignedRole) && !assignedBranch) {
      return res.status(400).json({ message: 'A branch is required for counter agents and branch admins.' })
    }

    const existing = await findMany('users', { filters: [['email', 'eq', email]], limit: 1 })
    if (existing.length) return res.status(409).json({ message: 'An account with this email already exists.' })

    const hashed = await bcrypt.hash(password, 12)
    const user = await insert('users', {
      name, email, password: hashed, phone: phone || '',
      role: assignedRole,
      branch: assignedBranch || null,
      notify_channel: notify_channel || 'email',
      status: STATUSES.includes(status) ? status : 'active',
    })
    res.status(201).json({ user: safeUser(user) })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('super_admin', 'branch_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const updates = {}
    ;['name', 'phone', 'role', 'branch', 'status', 'notify_channel'].forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f]
    })
    if (updates.role && !ROLES.includes(updates.role)) return res.status(400).json({ message: 'Invalid role.' })
    if (updates.status && !STATUSES.includes(updates.status)) return res.status(400).json({ message: 'Invalid status.' })

    const target = await findById('users', req.params.id)
    if (!target) return res.status(404).json({ message: 'User not found.' })

    if (req.user.role === 'branch_admin') {
      delete updates.role
      delete updates.branch
      if (target.role !== 'staff' || !sameId(target.branch, req.user.branch)) {
        return res.status(403).json({ message: 'You can only manage counter agents for your own branch.' })
      }
    }
    if (sameId(target.id, req.user.id) && (updates.role || updates.status === 'suspended')) {
      return res.status(400).json({ message: 'You cannot change your own role or suspend yourself.' })
    }

    const user = await updateById('users', target.id, updates)

    // Suspension or a role/branch change revokes live socket sessions immediately.
    if (updates.status === 'suspended' || updates.role || updates.branch) {
      req.app.get('io')?.revokeUserSockets(target.id)
    }

    res.json({ user: safeUser(user) })
  } catch (err) { next(err) }
})

router.delete('/:id', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    if (sameId(req.params.id, req.user.id)) return res.status(400).json({ message: 'You cannot delete your own account.' })
    req.app.get('io')?.revokeUserSockets(req.params.id)
    await deleteById('users', req.params.id)
    res.json({ message: 'User removed.' })
  } catch (err) { next(err) }
})

module.exports = router
