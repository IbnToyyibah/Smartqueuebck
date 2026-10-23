const express = require('express')
const { protect, authorize, requireActiveBranch, requireOwnBranch, canAccessBranch } = require('../middleware/auth')
const { findMany, insert, findById, updateById, deleteById } = require('../lib/supabaseRepo')
const { sameId } = require('../utils/common')

const router = express.Router()

// Loads :id and checks the counter belongs to the acting user's branch.
const loadCounter = async (req, res, next) => {
  try {
    const counter = await findById('counters', req.params.id)
    if (!counter) return res.status(404).json({ message: 'Counter not found.' })
    if (!canAccessBranch(req.user, counter.branch)) {
      return res.status(403).json({ message: 'You can only manage counters for your own branch.' })
    }
    req.counter = counter
    next()
  } catch (err) { next(err) }
}

// Ensures an agent being assigned is a counter agent of the same branch.
const validateAgent = async (agentId, branchId) => {
  if (!agentId) return null
  const agent = await findById('users', agentId)
  if (!agent || agent.role !== 'staff' || !sameId(agent.branch, branchId)) {
    return 'Assigned agent must be a counter agent of this branch.'
  }
  return null
}

router.get('/', protect, authorize('staff', 'branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const branch = req.user.role === 'super_admin' ? req.query.branch : req.user.branch
    if (!branch) return res.status(400).json({ message: 'branch query parameter is required.' })
    const filters = [['branch', 'eq', branch]]
    if (req.user.role === 'staff') filters.push(['agent', 'eq', req.user.id])
    const counters = await findMany('counters', { filters, order: { column: 'created_at', ascending: true } })
    res.json({ counters })
  } catch (err) { next(err) }
})

router.post('/', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, requireOwnBranch, async (req, res, next) => {
  try {
    const { name, branch, agent_id } = req.body
    if (!name || !branch) return res.status(400).json({ message: 'name and branch are required.' })
    const agentError = await validateAgent(agent_id, branch)
    if (agentError) return res.status(400).json({ message: agentError })
    const counter = await insert('counters', { name, branch, agent: agent_id || null, status: 'active' })
    res.status(201).json({ counter })
  } catch (err) { next(err) }
})

router.patch('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, loadCounter, async (req, res, next) => {
  try {
    const updates = {}
    ;['name', 'agent', 'status'].forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    if (updates.status && !['active', 'paused', 'closed'].includes(updates.status)) {
      return res.status(400).json({ message: 'status must be active, paused or closed.' })
    }
    const agentError = await validateAgent(updates.agent, req.counter.branch)
    if (agentError) return res.status(400).json({ message: agentError })
    const counter = await updateById('counters', req.counter.id, updates)
    res.json({ counter })
  } catch (err) { next(err) }
})

router.patch('/:id/toggle', protect, authorize('staff', 'branch_admin', 'super_admin'), requireActiveBranch, loadCounter, async (req, res, next) => {
  try {
    const { counter } = req
    if (req.user.role === 'staff' && !sameId(counter.agent, req.user.id)) {
      return res.status(403).json({ message: 'You can only manage your assigned counter.' })
    }
    const updated = await updateById('counters', counter.id, {
      status: counter.status === 'active' ? 'paused' : 'active',
    })
    const io = req.app.get('io')
    if (io) io.emitToBranch(String(counter.branch), 'counter:updated', updated)
    res.json({ counter: updated })
  } catch (err) { next(err) }
})

router.delete('/:id', protect, authorize('branch_admin', 'super_admin'), requireActiveBranch, loadCounter, async (req, res, next) => {
  try {
    await deleteById('counters', req.counter.id)
    res.json({ message: 'Counter removed.' })
  } catch (err) { next(err) }
})

module.exports = router
