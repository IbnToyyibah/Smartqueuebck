/**
 * Seed Script - run once: npm run seed
 * Creates real branches with real departments, counters and users.
 */
require('dotenv').config()

const bcrypt = require('bcryptjs')
const connectDB = require('./config/db')
const { findMany, deleteById, insert } = require('./lib/supabaseRepo')
const { getSeedServicesForBranch } = require('./utils/serviceCatalog')

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const defaultHours = () =>
  DAYS.map((day) => ({ day, open: day !== 'Sunday', from: '08:00', to: '17:00' }))

const hospitalDepts = () => [
  { id: 'consultation', name: 'Consultation', duration: 20, active: true },
  { id: 'pharmacy', name: 'Pharmacy', duration: 10, active: true },
  { id: 'xray', name: 'X-Ray', duration: 25, active: true },
  { id: 'laboratory', name: 'Laboratory', duration: 30, active: true },
  { id: 'emergency', name: 'Emergency', duration: 5, active: true },
]

const retailDepts = () => [
  { id: 'biscuits', name: 'Biscuits', duration: 8, active: true },
  { id: 'sweet', name: 'Sweet', duration: 8, active: true },
  { id: 'chocolate', name: 'Chocolate', duration: 8, active: true },
  { id: 'complaints', name: 'Complaint', duration: 12, active: true },
]

const govDepts = () => [
  { id: 'payment', name: 'Payment Section', duration: 15, active: true },
  { id: 'complaint', name: 'Complain Section', duration: 12, active: true },
]

const bankingDepts = () => [
  { id: 'account', name: 'Account Services', duration: 12, active: true },
  { id: 'loans', name: 'Loans & Credit', duration: 20, active: true },
  { id: 'payments', name: 'Payments', duration: 8, active: true },
  { id: 'buying', name: 'Buying', duration: 10, active: true },
  { id: 'inquiry', name: 'General Inquiry', duration: 8, active: true },
  { id: 'complaints', name: 'Complaints', duration: 10, active: true },
]

const SEED_USERS = {
  superAdmin: { email: 'superadmin@smartqueue.com', password: 'superadmin123' },
  branchAdmin: { email: 'admin@smartqueue.com', password: 'BranchAdmin@123' },
  staff: { email: 'staff@smartqueue.com', password: 'Staff@123' },
  customer: { email: 'customer@smartqueue.com', password: 'Customer@123' },
}

async function seedServices(branchId, servicesOrBranch) {
  const services = Array.isArray(servicesOrBranch)
    ? servicesOrBranch
    : getSeedServicesForBranch(servicesOrBranch)

  for (let i = 0; i < services.length; i += 1) {
    const s = services[i]
    await insert('services', {
      branch_id: branchId,
      name: s.name,
      description: s.description || '',
      duration: s.duration || 10,
      is_active: s.active !== false,
      sort_order: i,
      meta: {},
    })
  }
}

async function clearTable(table) {
  const rows = await findMany(table, { select: 'id' })
  for (const row of rows) {
    await deleteById(table, row.id)
  }
}

async function seed() {
  await connectDB()

  console.log('Clearing existing data...')
  await Promise.all([
    clearTable('notifications'),
    clearTable('queues'),
    clearTable('counters'),
    clearTable('users'),
    clearTable('branches'),
  ])

  console.log('Creating branches...')
  const now = new Date()
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
  const yearEnd = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()

  const generalHospital = await insert('branches', {
    name: 'General Hospital Ilorin',
    city: 'Ilorin',
    address: 'Hospital Road, Ilorin, Kwara State',
    phone: '+234 31 221 0001',
    email: 'info@generalhospitalilorin.gov.ng',
    status: 'operational',
    max_capacity: 200,
    category: 'healthcare',
    subscription_status: 'trial',
    trial_end_date: trialEnd,
    operating_hours: defaultHours(),
  })
  await seedServices(generalHospital.id, hospitalDepts())

  const shumadRetail = await insert('branches', {
    name: 'Shumad Global Ventures',
    city: 'Ilorin',
    address: 'Ilorin Branch, Kwara State',
    phone: '+234 803 000 0001',
    email: 'ilorin@shumadglobal.com',
    status: 'operational',
    max_capacity: 100,
    category: 'retail',
    subscription_status: 'active',
    subscription_end_date: yearEnd,
    operating_hours: defaultHours(),
  })
  await seedServices(shumadRetail.id, retailDepts())

  const kwirs = await insert('branches', {
    name: 'KWIRS - Kwara State Internal Revenue Service',
    city: 'Ilorin',
    address: 'Ilorin Branch, Kwara State',
    phone: '+234 803 000 0002',
    email: 'info@kwirs.gov.ng',
    status: 'operational',
    max_capacity: 150,
    category: 'government',
    subscription_status: 'active',
    subscription_end_date: yearEnd,
    operating_hours: defaultHours(),
  })
  await seedServices(kwirs.id, govDepts())

  const firstBank = await insert('branches', {
    name: 'First Continental Bank Lagos',
    city: 'Lagos',
    address: '14 Marina Street, Lagos Island',
    phone: '+234 1 234 5678',
    email: 'lagos@firstcontinental.com',
    status: 'operational',
    max_capacity: 150,
    category: 'banking',
    subscription_status: 'expired',
    operating_hours: defaultHours(),
  })
  await seedServices(firstBank.id, bankingDepts())

  console.log('Creating users...')
  const superAdminPw = await bcrypt.hash(SEED_USERS.superAdmin.password, 12)
  const branchAdminPw = await bcrypt.hash(SEED_USERS.branchAdmin.password, 12)
  const staffPw = await bcrypt.hash(SEED_USERS.staff.password, 12)
  const customerPw = await bcrypt.hash(SEED_USERS.customer.password, 12)

  await insert('users', {
    name: 'Fatima Suleiman',
    email: SEED_USERS.superAdmin.email,
    password: superAdminPw,
    phone: '+2348045678901',
    role: 'super_admin',
    status: 'active',
  })

  const branchAdmin = await insert('users', {
    name: 'Chidi Okafor',
    email: 'admin@smartqueue.com',
    password: branchAdminPw,
    phone: '+2348034567890',
    role: 'branch_admin',
    branch: generalHospital.id,
    status: 'active',
    trial_active: true,
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEnd,
  })

  const staffAmira = await insert('users', {
    name: 'Amira Bello',
    email: 'staff@smartqueue.com',
    password: staffPw,
    phone: '+2348023456789',
    role: 'staff',
    branch: generalHospital.id,
    status: 'active',
  })

  const staffTunde = await insert('users', {
    name: 'Tunde Bakare',
    email: 'tunde@smartqueue.com',
    password: staffPw,
    phone: '+2348031234567',
    role: 'staff',
    branch: generalHospital.id,
    status: 'active',
  })

  const staffRemi = await insert('users', {
    name: 'Remi Adeyemi',
    email: 'remi@smartqueue.com',
    password: staffPw,
    phone: '+2348045678901',
    role: 'staff',
    branch: generalHospital.id,
    status: 'active',
  })

  const staffKemi = await insert('users', {
    name: 'Kemi Ogbonna',
    email: 'kemi@smartqueue.com',
    password: staffPw,
    phone: '+2348056789012',
    role: 'staff',
    branch: generalHospital.id,
    status: 'active',
  })

  await insert('users', {
    name: 'Mujeeb Olawale',
    email: 'customer@smartqueue.com',
    password: customerPw,
    phone: '+2348012345678',
    role: 'customer',
    status: 'active',
  })

  console.log('Creating counters...')
  await insert('counters', { name: 'Consultation Desk 1', branch: generalHospital.id, agent: staffTunde.id, status: 'active' })
  await insert('counters', { name: 'Consultation Desk 2', branch: generalHospital.id, agent: staffAmira.id, status: 'active' })
  await insert('counters', { name: 'Pharmacy Counter', branch: generalHospital.id, agent: staffRemi.id, status: 'active' })
  await insert('counters', { name: 'X-Ray Desk', branch: generalHospital.id, agent: staffKemi.id, status: 'active' })
  await insert('counters', { name: 'Laboratory Counter', branch: generalHospital.id, agent: null, status: 'closed' })

  await insert('counters', { name: 'Counter 1', branch: shumadRetail.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Counter 2', branch: shumadRetail.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Counter 3', branch: shumadRetail.id, agent: null, status: 'active' })

  await insert('counters', { name: 'Payment Counter 1', branch: kwirs.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Payment Counter 2', branch: kwirs.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Complaint Desk', branch: kwirs.id, agent: null, status: 'active' })

  await insert('counters', { name: 'Counter 1', branch: firstBank.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Counter 2', branch: firstBank.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Counter 3', branch: firstBank.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Counter 4', branch: firstBank.id, agent: null, status: 'active' })
  await insert('counters', { name: 'Counter 5', branch: firstBank.id, agent: null, status: 'closed' })

  console.log('\nSeed complete!\n')
  console.log('Branches: Healthcare, Retail, Government, Banking')
  console.log(`Users: ${SEED_USERS.superAdmin.email} / ${SEED_USERS.superAdmin.password}`)
  console.log(`       ${SEED_USERS.branchAdmin.email} / ${SEED_USERS.branchAdmin.password}`)
  console.log(`       ${SEED_USERS.staff.email} / ${SEED_USERS.staff.password}`)
  console.log(`       ${SEED_USERS.customer.email} / ${SEED_USERS.customer.password}`)
  console.log(`Seeded branch admin user: ${branchAdmin.email}`)
  console.log('\nRun `npm run dev` to start the server.')
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
