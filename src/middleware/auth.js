const jwt = require('jsonwebtoken')
const { findById } = require('../lib/supabaseRepo')
const { BRANCH_INACTIVE_MESSAGE, isBranchActive } = require('../utils/branchSubscription')
const { hasPermission } = require('../utils/permissions')

const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1]
  }
  // Check HttpOnly or standard cookie fallback
  if (req.cookies?.sq_token) {
    return req.cookies.sq_token
  }
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/sq_token=([^;]+)/)
    if (match) return match[1]
  }
  return null
}

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
  const token = extractToken(req)
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

const requirePermission = (...requiredPermissions) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated.' })
  }
  const permitted = requiredPermissions.every((perm) => hasPermission(req.user.role, perm))
  if (!permitted) {
    return res.status(403).json({
      message: `Required permissions [${requiredPermissions.join(', ')}] not granted for role '${req.user.role}'.`,
    })
  }
  next()
}

const optionalAuth = async (req, res, next) => {
  const token = extractToken(req)
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await findById('users', decoded.id)
      if (user && user.status !== 'suspended') req.user = signUserPayload(user)
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

const requireOwnBranch = (req, res, next) => {
  if (!req.user || req.user.role === 'super_admin') return next()

  const targetBranchId =
    req.params?.branchId ||
    req.params?.id ||
    req.body?.branchId ||
    req.body?.branch ||
    req.query?.branchId ||
    req.query?.branch

  if (!targetBranchId) return next()

  if (['branch_admin', 'staff'].includes(req.user.role)) {
    if (!req.user.branch || String(req.user.branch) !== String(targetBranchId)) {
      return res.status(403).json({
        message: 'You can only access or manage your own assigned branch.',
      })
    }
  }

  next()
}

module.exports = {
  protect,
  authorize,
  requirePermission,
  optionalAuth,
  requireActiveBranch,
  requireOwnBranch,
  extractToken,
}
