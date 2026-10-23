const { insert } = require('../lib/supabaseRepo')
const { DEFAULT_SERVICES } = require('./serviceCatalog')

const DEFAULT_HOURS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
  (day) => ({ day, open: day !== 'Sunday', from: '08:00', to: '17:00' })
)

const toSafeNumber = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode })

const safeUser = (user) => {
  if (!user) return null
  const copy = { ...user }
  delete copy.password
  return copy
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase()

const sameId = (a, b) => a !== null && a !== undefined && String(a) === String(b)

const seedServices = async (branchId, services = DEFAULT_SERVICES) => {
  for (let i = 0; i < services.length; i += 1) {
    const service = services[i]
    await insert('services', {
      branch_id: branchId,
      name: service.name,
      description: service.description || '',
      duration: service.duration ?? 10,
      is_active: service.active !== false && service.is_active !== false,
      sort_order: service.sort_order ?? i,
      meta: service.meta || {},
    })
  }
}

module.exports = {
  DEFAULT_HOURS,
  toSafeNumber,
  httpError,
  safeUser,
  normalizeEmail,
  sameId,
  seedServices,
}
