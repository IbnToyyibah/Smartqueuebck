const express = require('express')
const { protect, authorize, requireOwnBranch } = require('../middleware/auth')
const queueSvc = require('../services/queueService')
const { toSafeNumber } = require('../utils/common')

const router = express.Router()

const sinceDays = (value) => {
  const days = Math.min(Math.max(toSafeNumber(value, 7), 1), 365)
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  from.setDate(from.getDate() - (days - 1))
  return from
}

router.get('/branch/:branchId', protect, authorize('branch_admin', 'super_admin'), requireOwnBranch, async (req, res, next) => {
  try {
    const analytics = await queueSvc.getBranchAnalytics(req.params.branchId, sinceDays(req.query.days))
    res.json(analytics)
  } catch (err) { next(err) }
})

router.get('/platform', protect, authorize('super_admin'), async (req, res, next) => {
  try {
    const perBranch = await queueSvc.getPlatformAnalytics(sinceDays(req.query.days))
    res.json({ perBranch })
  } catch (err) { next(err) }
})

module.exports = router
