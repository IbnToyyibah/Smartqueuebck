const jwt = require('jsonwebtoken')
const { findById } = require('../lib/supabaseRepo')
const { BRANCH_INACTIVE_MESSAGE, isBranchActive } = require('../utils/branchSubscription')
const { hasPermission } = require('../utils/permissions')

const BRANCH_ROLES = ['staff', 'branch_admin']

const readCookieToken = (cookieHeader) => {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|;\s*)sq_token=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1]
  }
  return readCookieToken(req.headers.cookie)
}

const signUserPayload = (user) => ({
  id: user.id,
  role: user.role,
  branch: user.branch,
  email: user.email,
  phone: user.phone,
  name: user.name,
  status: user.status,
  notify_channel: user.notify_channel,
  trial_started_at: user.trial_started_at,
  trial_ends_at: user.trial_ends_at,
  trial_active: user.trial_active,
})

const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return null
  }
}

const protect = async (req, res, next) => {
  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({ message: 'Not authenticated. Token missing.' })
  }
  const decoded = verifyToken(token)
  if (!decoded) return res.status(401).json({ message: 'Invalid or expired token.' })

  try {
    const user = await findById('users', decoded.id)
    if (!user) return res.status(401).json({ message: 'User no longer exists.' })
    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Account suspended.' })
    }
    req.user = signUserPayload(user)
    next()
  } catch (err) {
    // Database failures are server errors, not authentication failures.
    next(err)
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
  const decoded = token && verifyToken(token)
  if (!decoded) return next()
  try {
    const user = await findById('users', decoded.id)
    if (user && user.status !== 'suspended') req.user = signUserPayload(user)
    next()
  } catch (err) {
    next(err)
  }
}

const requireActiveBranch = async (req, res, next) => {
  if (!req.user || !BRANCH_ROLES.includes(req.user.role)) return next()
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

/**
 * Restricts staff and branch admins to their own branch.
 * `paramName` is the route param that holds a *branch* id ("branchId" by default,
 * "id" on /branches/:id routes). Routes whose :id is a counter/user/ticket id must
 * check ownership against the loaded record instead.
 */
const ownBranch = (paramName = 'branchId') => (req, res, next) => {
  if (!req.user || !BRANCH_ROLES.includes(req.user.role)) return next()

  const targetBranchId =
    req.params?.[paramName] ||
    req.body?.branchId ||
    req.body?.branch ||
    req.query?.branchId ||
    req.query?.branch

  if (!targetBranchId) return next()

  if (!req.user.branch || String(req.user.branch) !== String(targetBranchId)) {
    return res.status(403).json({
      message: 'You can only access or manage your own assigned branch.',
    })
  }
  next()
}

const requireOwnBranch = ownBranch('branchId')

// Returns true when the user may act on a record that belongs to `branchId`.
const canAccessBranch = (user, branchId) =>
  user?.role === 'super_admin' ||
  (BRANCH_ROLES.includes(user?.role) && user.branch && String(user.branch) === String(branchId))

module.exports = {
  protect,
  authorize,
  requirePermission,
  optionalAuth,
  requireActiveBranch,
  requireOwnBranch,
  ownBranch,
  canAccessBranch,
  extractToken,
  readCookieToken,
  verifyToken,
}
