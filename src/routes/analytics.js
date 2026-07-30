const express = require('express')
const { protect, authorize, requireOwnBranch } = require('../middleware/auth')
const { findMany } = require('../lib/supabaseRepo')

const router = express.Router()

router.get('/branch/:branchId', protect, authorize('branch_admin', 'super_admin'), requireOwnBranch, async (req, res, next) => {
  try {
    const tickets = await findMany('queues', { filters: [['branch', 'eq', req.params.branchId]] })
    const totalServed = tickets.filter((t) => t.status === 'served').length
    const totalNoShow = tickets.filter((t) => t.status === 'noshow').length
    const totalTickets = tickets.length
    res.json({
      daily: [],
      hourly: [],
      services: [],
      totals: { totalServed, totalNoShow, totalTickets, avgWait: 0 },
    })
  } catch (err) { next(err) }
})

router.get('/platform', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const perBranch = []
    res.json({ perBranch })
  } catch (err) { next(err) }
})

module.exports = router
