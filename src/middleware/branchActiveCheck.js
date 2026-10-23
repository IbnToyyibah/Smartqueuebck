const { getEffectiveBranchStatus, isActiveSubscriptionStatus } = require('../utils/branchSubscription')

// Blocks public actions (e.g. joining a queue) against branches whose subscription lapsed.
const branchActiveCheck = async (req, res, next) => {
  try {
    const branchId =
      req.body?.branch_id ||
      req.body?.branchId ||
      req.params?.branchId ||
      req.query?.branchId

    if (!branchId) return next()
    if (typeof branchId === 'string' && !branchId.trim()) {
      return res.status(400).json({ message: 'branchId is required.' })
    }

    const { branch, status } = await getEffectiveBranchStatus(String(branchId))
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })

    if (!isActiveSubscriptionStatus(status)) {
      return res.status(402).json({
        message: `${branch.name}'s subscription has expired. Please try another branch or contact your Branch Admin.`,
        branchExpired: true,
        subscriptionStatus: status,
      })
    }

    req.branch = branch
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = branchActiveCheck
