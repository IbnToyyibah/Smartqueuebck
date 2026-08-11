const trialCheck = (req, res, next) => {
  const u = req.user
  if (!u || u.role !== 'branch_admin') return next()
  if (u.subscribed) return next()

  if (u.trial_active && u.trial_ends_at) {
    if (new Date() > new Date(u.trial_ends_at)) {
      return res.status(402).json({
        message: 'Your 14-day free trial has expired. Please subscribe to continue.',
        trialExpired: true,
      })
    }
  }
  next()
}

module.exports = trialCheck
