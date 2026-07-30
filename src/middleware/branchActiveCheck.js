const { findById, updateById } = require('../lib/supabaseRepo')

const branchActiveCheck = async (req, res, next) => {
  try {
    const branchId =
      req.body?.branchId ||
      req.params?.branchId ||
      req.query?.branchId

    if (!branchId) return next()
    if (typeof branchId === 'string' && !branchId.trim()) {
      return res.status(400).json({ message: 'branchId is required.' })
    }

    const branch = await findById('branches', branchId)
    if (!branch) return res.status(404).json({ message: 'Branch not found.' })

    const now = new Date()
    let status = branch.subscription_status
    const trialEnd = branch.trial_end_date
    const subscriptionEnd = branch.subscription_end_date

    if (status === 'trial' && trialEnd && now > new Date(trialEnd)) {
      status = 'expired'
      await updateById('branches', branchId, { subscription_status: 'expired' })
    }

    if (status === 'active' && subscriptionEnd && now > new Date(subscriptionEnd)) {
      status = 'expired'
      await updateById('branches', branchId, { subscription_status: 'expired' })
    }

    if (status === 'expired' || status === 'suspended') {
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
