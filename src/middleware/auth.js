const jwt = require('jsonwebtoken')
const { findById } = require('../lib/supabaseRepo')
const { BRANCH_INACTIVE_MESSAGE, isBranchActive } = require('../utils/branchSubscription')

const signUserPayload = (user) => ({
  id: user.id,
  role: user.role,
  branch: user.branch,
  email: user.email,
  name: user.name,
  status: user.status,
  notify_channel: user.notify_channel,
  trial_started_at: user.trial_started_at,
  trial_ends_at: user.trial_ends_at,
  trial_active: user.trial_active,
})

const protect = async (req, res, next) => {
  let token
  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1]
  }
  if (!token) {
    return res.status(401).json({ message: 'Not authenticated. Token missing.' })
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await findById('users', decoded.id)
    if (!user) return res.status(401).json({ message: 'User no longer exists.' })
    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Account suspended.' })
    }
    req.user = signUserPayload(user)
    next()
  } catch {
    res.status(401).json({ message: 'Invalid or expired token.' })
  }
}

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({
      message: `Role '${req.user?.role}' is not permitted to access this resource.`,
    })
  }
  next()
}

const optionalAuth = async (req, res, next) => {
  let token
  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1]
  }
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await findById('users', decoded.id)
      if (user) req.user = signUserPayload(user)
    } catch {}
  }
  next()
}

const requireActiveBranch = async (req, res, next) => {
  if (!req.user || !['staff', 'branch_admin'].includes(req.user.role)) return next()
  if (!req.user.branch) return next()
  try {
    const result = await isBranchActive(req.user.branch)
    if (!result.active) {
      return res.status(402).json({
        message: BRANCH_INACTIVE_MESSAGE,
        branchExpired: true,
        subscriptionStatus: result.status,
      })
    }
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = { protect, authorize, optionalAuth, requireActiveBranch }
