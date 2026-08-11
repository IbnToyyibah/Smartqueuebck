const DEFAULT_SERVICES = [
  { id: 'general', name: 'General Inquiry', duration: 8, active: true },
  { id: 'account', name: 'Account Services', duration: 12, active: true },
  { id: 'loans', name: 'Loans & Credit', duration: 20, active: true },
  { id: 'consultation', name: 'Medical Consultation', duration: 15, active: true },
  { id: 'document', name: 'Document Processing', duration: 10, active: true },
  { id: 'complaints', name: 'Complaints & Feedback', duration: 10, active: true },
  { id: 'buying', name: 'Buying', duration: 10, active: true },
]

const CATEGORY_SERVICE_MAP = {
  healthcare: [
    { id: 'consultation', name: 'Medical Consultation', duration: 15, active: true },
    { id: 'pharmacy', name: 'Pharmacy', duration: 10, active: true },
    { id: 'xray', name: 'X-Ray', duration: 20, active: true },
    { id: 'laboratory', name: 'Laboratory', duration: 20, active: true },
    { id: 'emergency', name: 'Emergency', duration: 5, active: true },
  ],
  retail: [
    { id: 'general', name: 'General Inquiry', duration: 8, active: true },
    { id: 'account', name: 'Account Services', duration: 12, active: true },
    { id: 'buying', name: 'Buying', duration: 10, active: true },
    { id: 'complaints', name: 'Complaints & Feedback', duration: 10, active: true },
  ],
  government: [
    { id: 'verification', name: 'Verification', duration: 10, active: true },
    { id: 'registration', name: 'Registration', duration: 15, active: true },
    { id: 'payment', name: 'Payment', duration: 10, active: true },
    { id: 'inquiry', name: 'Inquiry', duration: 10, active: true },
    { id: 'document', name: 'Document Processing', duration: 15, active: true },
  ],
  banking: [
    { id: 'account', name: 'Account Services', duration: 12, active: true },
    { id: 'loans', name: 'Loans & Credit', duration: 20, active: true },
    { id: 'payments', name: 'Payments', duration: 10, active: true },
    { id: 'buying', name: 'Buying', duration: 10, active: true },
    { id: 'inquiry', name: 'General Inquiry', duration: 8, active: true },
    { id: 'complaints', name: 'Complaints', duration: 10, active: true },
  ],
}

const normalizeServices = (services = []) =>
  services
    .map((service, index) => ({
      id: service.id || service._id,
      name: service.name || service.label || '',
      description: service.description || '',
      duration: service.duration ?? 10,
      active: service.active !== false && service.is_active !== false,
      sort_order: service.sort_order ?? index,
      meta: service.meta || {},
    }))
    .filter((service) => service.id && service.name)

const getSeedServicesForBranch = (branch) => {
  const embedded = normalizeServices(branch?.services)
  if (embedded.length) return embedded
  return CATEGORY_SERVICE_MAP[String(branch?.category || '').toLowerCase()] || DEFAULT_SERVICES
}

module.exports = {
  DEFAULT_SERVICES,
  CATEGORY_SERVICE_MAP,
  normalizeServices,
  getSeedServicesForBranch,
}
