const { findById, updateById } = require('../lib/supabaseRepo')

const BRANCH_INACTIVE_MESSAGE =
  "This branch's subscription has expired. Please try another branch."

const isActiveSubscriptionStatus = (status) => status === 'active' || status === 'trial'

const getEffectiveBranchStatus = async (branchOrId) => {
  const branch = typeof branchOrId === 'string'
    ? await findById('branches', branchOrId)
    : branchOrId

  if (!branch) return { branch: null, status: null }

  const now = new Date()
  let status = branch.subscription_status
  const trialEnd = branch.trial_end_date
  const subscriptionEnd = branch.subscription_end_date

  if (status === 'trial' && trialEnd && now > new Date(trialEnd)) status = 'expired'
  if (status === 'active' && subscriptionEnd && now > new Date(subscriptionEnd)) status = 'expired'

  if (status !== branch.subscription_status) {
    const updated = await updateById('branches', branch.id, { subscription_status: status })
    return { branch: updated || branch, status }
  }

  return { branch, status }
}

const isBranchActive = async (branchOrId) => {
  const result = await getEffectiveBranchStatus(branchOrId)
  return { ...result, active: isActiveSubscriptionStatus(result.status) }
}

module.exports = {
  BRANCH_INACTIVE_MESSAGE,
  getEffectiveBranchStatus,
  isActiveSubscriptionStatus,
  isBranchActive,
}
