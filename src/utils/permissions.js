/**
 Permissions Matrix for SmartQueue
 Maps organizational roles to fine-grained access control permissions.
 */

const PERMISSIONS = {
  // Queue operations
  QUEUE_JOIN: 'queue:join',
  QUEUE_VIEW_OWN: 'queue:view_own',
  QUEUE_VIEW_BRANCH: 'queue:view_branch',
  QUEUE_CALL: 'queue:call',
  QUEUE_SERVE: 'queue:serve',
  QUEUE_NOSHOW: 'queue:noshow',
  QUEUE_TRANSFER: 'queue:transfer',
  QUEUE_SKIP: 'queue:skip',
  QUEUE_RECALL: 'queue:recall',

  // Branch management
  BRANCH_VIEW: 'branch:view',
  BRANCH_MANAGE: 'branch:manage',
  BRANCH_SETTINGS: 'branch:settings',
  SERVICES_MANAGE: 'services:manage',
  COUNTERS_MANAGE: 'counters:manage',

  // Staff & User management
  STAFF_MANAGE: 'staff:manage',
  USERS_MANAGE: 'users:manage',

  // Analytics & System
  ANALYTICS_VIEW: 'analytics:view',
  REPORTS_EXPORT: 'reports:export',
  SYSTEM_MANAGE: 'system:manage',
  AUDIT_VIEW: 'audit:view',
}

const ROLE_PERMISSIONS = {
  customer: [
    PERMISSIONS.QUEUE_JOIN,
    PERMISSIONS.QUEUE_VIEW_OWN,
    PERMISSIONS.BRANCH_VIEW,
  ],

  staff: [
    PERMISSIONS.QUEUE_JOIN,
    PERMISSIONS.QUEUE_VIEW_OWN,
    PERMISSIONS.QUEUE_VIEW_BRANCH,
    PERMISSIONS.QUEUE_CALL,
    PERMISSIONS.QUEUE_SERVE,
    PERMISSIONS.QUEUE_NOSHOW,
    PERMISSIONS.QUEUE_TRANSFER,
    PERMISSIONS.QUEUE_SKIP,
    PERMISSIONS.QUEUE_RECALL,
    PERMISSIONS.BRANCH_VIEW,
  ],

  branch_admin: [
    PERMISSIONS.QUEUE_JOIN,
    PERMISSIONS.QUEUE_VIEW_OWN,
    PERMISSIONS.QUEUE_VIEW_BRANCH,
    PERMISSIONS.QUEUE_CALL,
    PERMISSIONS.QUEUE_SERVE,
    PERMISSIONS.QUEUE_NOSHOW,
    PERMISSIONS.QUEUE_TRANSFER,
    PERMISSIONS.QUEUE_SKIP,
    PERMISSIONS.QUEUE_RECALL,
    PERMISSIONS.BRANCH_VIEW,
    PERMISSIONS.BRANCH_MANAGE,
    PERMISSIONS.BRANCH_SETTINGS,
    PERMISSIONS.SERVICES_MANAGE,
    PERMISSIONS.COUNTERS_MANAGE,
    PERMISSIONS.STAFF_MANAGE,
    PERMISSIONS.ANALYTICS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
  ],

  super_admin: Object.values(PERMISSIONS),
}

function hasPermission(userRole, permission) {
  if (!userRole) return false
  if (userRole === 'super_admin') return true
  const allowed = ROLE_PERMISSIONS[userRole] || []
  return allowed.includes(permission)
}

function getPermissionsForRole(role) {
  if (role === 'super_admin') return Object.values(PERMISSIONS)
  return ROLE_PERMISSIONS[role] || []
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  getPermissionsForRole,
}
