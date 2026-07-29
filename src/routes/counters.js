const express = require('express')
const { protect, authorize, requireActiveBranch } = require('../middleware/auth')
const { findMany, insert, findById, updateById, deleteById } = require('../lib/supabaseRepo')

const router = express.Router()

router.get('/', protect, requireActiveBranch, async (req, res, next) => {
  try {
    const filters = []
    if (req.query.branch) filters.push(['branch', 'eq', req.query.branch])
    if (req.user.role === 'staff') filters.push(['agent', 'eq', req.user.id])
    const counters = await findMany('counters', { filters, order: { column: 'created_at', ascending: true } })
    res.json({ counters })
  } catch (err) { next(err) }
})

router.post('/', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const { name, branch, agent_id } = req.body
    if (!name || !branch) return res.status(400).json({ message: 'name and branch are required.' })
    const counter = await insert('counters', { name, branch, agent: agent_id || null, status: 'active' })
    res.status(201).json({ counter })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const allowed = ['name', 'agent', 'status']
    const updates = {}
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    const counter = await updateById('counters', req.params.id, updates)
    if (!counter) return res.status(404).json({ message: 'Counter not found.' })
    res.json({ counter })
  } catch (err) { next(err) }
})

router.patch('/:id/toggle', protect, authorize('staff', 'branch_admin', 'super_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    const counter = await findById('counters', req.params.id)
    if (!counter) return res.status(404).json({ message: 'Counter not found.' })
    if (req.user.role === 'staff' && String(counter.agent) !== String(req.user.id)) {
      return res.status(403).json({ message: 'You can only manage your assigned counter.' })
    }
    const updated = await updateById('counters', req.params.id, {
      status: counter.status === 'active' ? 'paused' : 'active',
    })
    const io = req.app.get('io')
    if (io) io.to(String(counter.branch)).emit('counter:updated', updated)
    res.json({ counter: updated })
  } catch (err) { next(err) }
})

router.delete('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, async (req, res, next) => {
  try {
    await deleteById('counters', req.params.id)
    res.json({ message: 'Counter removed.' })
  } catch (err) { next(err) }
})

module.exports = router
