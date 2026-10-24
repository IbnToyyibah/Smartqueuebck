require('dotenv').config()

const bcrypt = require('bcryptjs')
const connectDB = require('./config/db')
const { findMany, insert, updateById } = require('./lib/supabaseRepo')

// Cottage Hospital Ilorin (same branch as cottage@smartqueue.com).
const BRANCH_ADMIN_BRANCH_ID = '57665bfa-f465-477e-ad7e-e7abd260a448'

async function run() {
  if (!(await connectDB())) throw new Error('Database is not configured.')

  const now = new Date()
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()

  const accounts = [
    {
      name: 'Fatima Suleiman',
      email: 'superadmin@smartqueue.com',
      password: 'superadmin123',
      phone: '+2348045678901',
      role: 'super_admin',
    },
    {
      name: 'Chidi Okafor',
      email: 'admin@smartqueue.com',
      password: 'BranchAdmin@123',
      phone: '+2348034567890',
      role: 'branch_admin',
      branch: BRANCH_ADMIN_BRANCH_ID,
      trial_active: true,
      trial_started_at: now.toISOString(),
      trial_ends_at: trialEnd,
    },
  ]

  for (const { password, ...account } of accounts) {
    const existing = await findMany('users', { filters: [['email', 'in', [account.email]]], limit: 1 })
    if (existing.length) {
      console.log(`Exists, skipped: ${account.email}`)
      continue
    }
    await insert('users', { ...account, password: await bcrypt.hash(password, 12), status: 'active' })
    console.log(`Created: ${account.email} / ${password} (${account.role})`)
  }

  const branches = await findMany('branches', { select: 'id' })
  for (const branch of branches) {
    await updateById('branches', branch.id, { subscription_status: 'trial', trial_end_date: trialEnd })
  }
  console.log(`Extended ${branches.length} branch trials to ${trialEnd}`)

  const admins = await findMany('users', { filters: [['role', 'in', ['branch_admin']]] })
  for (const admin of admins) {
    await updateById('users', admin.id, { trial_active: true, trial_ends_at: trialEnd })
  }
  console.log(`Updated trial dates for ${admins.length} branch admins`)
}

run().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
