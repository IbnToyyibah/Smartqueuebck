const express = require('express')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { body, validationResult } = require('express-validator')
const { findMany, findById, insert, updateById } = require('../lib/supabaseRepo')
const { protect } = require('../middleware/auth')
const { BRANCH_INACTIVE_MESSAGE, isBranchActive } = require('../utils/branchSubscription')
const { DEFAULT_SERVICES } = require('../utils/serviceCatalog')
const { ROLE_PERMISSIONS, PERMISSIONS } = require('../utils/permissions')
const notifySvc = require('../services/notificationService')

const router = express.Router()

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })

const sendToken = (user, statusCode, res) => {
  const token = signToken(user.id)

  // Set HttpOnly cookie for enhanced security against XSS token theft
  res.cookie('sq_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })

  res.status(statusCode).json({
    token,
    user,
  })
}

const DEFAULT_HOURS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
  (day) => ({ day, open: day !== 'Sunday', from: '08:00', to: '17:00' })
)

const seedDefaultServices = async (branchId, services = DEFAULT_SERVICES) => {
  for (let i = 0; i < services.length; i += 1) {
    const service = services[i]
    await insert('services', {
      branch_id: branchId,
      name: service.name,
      description: service.description || '',
      duration: service.duration ?? 10,
      is_active: service.active !== false,
      sort_order: i,
      meta: {},
    })
  }
}

const safeUser = (user) => {
  if (!user) return null
  const copy = { ...user }
  delete copy.password
  return copy
}

router.get('/permissions', protect, (req, res) => {
  res.json({
    permissions: PERMISSIONS,
    rolePermissions: ROLE_PERMISSIONS,
    userPermissions: ROLE_PERMISSIONS[req.user.role] || [],
  })
})

router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required.'),
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
    body('role')
      .optional()
      .isIn(['customer', 'branch_admin'])
      .withMessage('Invalid role. Only customer or branch_admin may self-register.'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req)
      if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg })

      const {
        name, email, password, phone, role, notify_channel, branch,
        cardNumber, cardExpiry, cardCvc, cardHolder, orgName,
        branchCity, branchAddress, branchCategory,
      } = req.body

      if (role === 'staff') return res.status(400).json({ message: 'Counter agents are created by your Branch Admin.' })
      if (role === 'super_admin') return res.status(403).json({ message: 'Super Admin accounts cannot be self-registered.' })

      const existing = await findMany('users', { filters: [['email', 'eq', email]], limit: 1 })
      if (existing.length) return res.status(409).json({ message: 'An account with this email already exists.' })

      const assignedRole = role || 'customer'

      if (assignedRole === 'branch_admin') {
        if (!cardNumber || !cardExpiry || !cardCvc || !cardHolder) {
          return res.status(400).json({ message: 'Card details (number, expiry, CVC, and cardholder name) are required for Branch Admin registration.' })
        }
        if (!orgName || !branchCity || !branchAddress) {
          return res.status(400).json({ message: 'Branch name, city, and address are required for Branch Admin registration.' })
        }
      }

      const now = new Date()
      const trial = assignedRole === 'branch_admin'
        ? { trial_started_at: now.toISOString(), trial_ends_at: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(), trial_active: true }
        : {}

      let createdBranch = null
      if (assignedRole === 'branch_admin') {
        createdBranch = await insert('branches', {
          name: orgName,
          city: branchCity,
          address: branchAddress,
          phone: phone || '',
          email,
          category: branchCategory || 'other',
          subscription_status: 'trial',
          trial_end_date: trial.trial_ends_at,
          operating_hours: DEFAULT_HOURS,
          billing_details: {
            card_holder: cardHolder,
            card_last4: String(cardNumber || '').slice(-4),
            card_expiry: cardExpiry,
          },
        })
        await seedDefaultServices(createdBranch.id)
      }

      const hashed = await bcrypt.hash(password, 12)
      const user = await insert('users', {
        name,
        email,
        password: hashed,
        phone: phone || '',
        role: assignedRole,
        notify_channel: notify_channel || 'email',
        branch: createdBranch?.id || branch || null,
        ...trial,
        status: 'active',
      })

      sendToken(safeUser(user), 201, res)
    } catch (err) {
      next(err)
    }
  }
)

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email required.').normalizeEmail(),
    body('password').notEmpty().withMessage('Password required.'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req)
      if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg })

      const email = String(req.body.email || '').trim().toLowerCase()
      const { password } = req.body
      const users = await findMany('users', { filters: [['email', 'eq', email]], limit: 1 })
      const user = users[0]

      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ message: 'Invalid email or password.' })
      }
      if (user.status === 'suspended') return res.status(403).json({ message: 'Account suspended. Contact support.' })
      if (['staff', 'branch_admin'].includes(user.role) && user.branch) {
        const { active, status } = await isBranchActive(user.branch)
        if (!active) {
          return res.status(402).json({
            message: BRANCH_INACTIVE_MESSAGE,
            branchExpired: true,
            subscription_status: status,
          })
        }
      }

      if (user.role === 'customer') {
        const activeTickets = await findMany('queues', {
          filters: [['user', 'eq', user.id], ['status', 'in', ['waiting', 'called', 'serving', 'checked_in']]],
          order: { column: 'created_at', ascending: false },
          limit: 1,
        })
        const activeTicket = activeTickets[0]
        if (activeTicket) {
          const branch = await findById('branches', activeTicket.branch)
          const result = await notifySvc.sendQueueTicketEmail({
            to: user.email,
            ticket: activeTicket,
            branch,
          })
          if (result.error) console.error('[notification] login queue email failed:', result.error)
        }
      }

      sendToken(safeUser(user), 200, res)
    } catch (err) {
      next(err)
    }
  }
)

router.get('/me', protect, async (req, res, next) => {
  try {
    const users = await findMany('users', { filters: [['id', 'eq', req.user.id]], limit: 1 })
    res.json({ user: safeUser(users[0]) })
  } catch (err) {
    next(err)
  }
})

router.patch('/me', protect, async (req, res, next) => {
  try {
    const allowed = ['name', 'phone', 'notify_channel']
    const updates = {}
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    const user = await updateById('users', req.user.id, updates)
    res.json({ user: safeUser(user) })
  } catch (err) {
    next(err)
  }
})

router.post('/change-password', protect, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Both current and new passwords are required.' })
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' })
    }

    const users = await findMany('users', { filters: [['id', 'eq', req.user.id]], limit: 1 })
    const user = users[0]
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(401).json({ message: 'Current password is incorrect.' })
    }

    const hashed = await bcrypt.hash(newPassword, 12)
    const updated = await updateById('users', req.user.id, { password: hashed })
    sendToken(safeUser(updated), 200, res)
  } catch (err) {
    next(err)
  }
})

module.exports = router
