const { insert, updateById } = require('../lib/supabaseRepo')

const getTwilio = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null
  const twilio = require('twilio')
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
}

const sendEmail = async ({ to, subject, html, text, attachments = [] }) => {
  const apiKey = process.env.BREVO_API_KEY
  const senderEmail = process.env.BREVO_SENDER_EMAIL
  const senderName = process.env.BREVO_SENDER_NAME || 'SmartQueue'
  if (!apiKey || !senderEmail) {
    return { skipped: true, error: 'Brevo is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL.' }
  }

  try {
    const payload = {
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html || `<p>${escapeHtml(text || '')}</p>`,
    }
    if (attachments.length) payload.attachment = attachments

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`Brevo HTTP ${response.status}: ${result.message || 'Email delivery failed.'}`)
    return { messageId: result.messageId }
  } catch (err) {
    return { error: err.message }
  }
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;')

const sendQueueTicketEmail = async ({ to, ticket, branch }) => {
  if (!to || !ticket) return { skipped: true }

  const service = typeof ticket.service === 'string' ? JSON.parse(ticket.service) : ticket.service || {}
  const branchName = branch?.name || 'your selected branch'
  const ticketNumber = ticket.ticket_number || ticket.ticketNumber || 'your ticket'
  const qrCode = String(ticket.qr_code || '')
  const qrMatch = qrCode.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
  const queuePosition = Number(ticket.position) > 0 ? Number(ticket.position) : null
  const qrMarkup = qrMatch
    ? `<p><img src="${qrCode}" alt="QR code for ticket ${escapeHtml(ticketNumber)}" width="220" height="220"></p><p>A copy of your QR code is attached too.</p>`
    : '<p>Your QR code is not available yet. Please open your ticket in SmartQueue.</p>'

  const html = `
    <h2>You are on a queue</h2>
    <p>You have joined the queue at <strong>${escapeHtml(branchName)}</strong>.</p>
    <p>Ticket: <strong>${escapeHtml(ticketNumber)}</strong></p>
    <p>Queue position: <strong>${queuePosition ? `#${queuePosition}` : 'Updating'}</strong></p>
    <p>Service: ${escapeHtml(service.name || 'Selected service')}</p>
    ${qrMarkup}
    <p>Please keep this QR code available when you arrive at the branch.</p>
  `
  const text = [
    'You are on a queue',
    `Branch: ${branchName}`,
    `Ticket: ${ticketNumber}`,
    `Queue position: ${queuePosition ? `#${queuePosition}` : 'Updating'}`,
    `Service: ${service.name || 'Selected service'}`,
    'Your QR code is included in this email.',
  ].join('\n')

  const attachments = qrMatch
    ? [{ name: `smartqueue-${ticketNumber}.png`, content: qrMatch[2] }]
    : []

  return sendEmail({
    to,
    subject: `SmartQueue - You are on a queue at ${branchName}`,
    html,
    text,
    attachments,
  })
}

const sendSMS = async ({ to, body }) => {
  const client = getTwilio()
  if (!client) return { skipped: true }
  try {
    const msg = await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to })
    return { sid: msg.sid }
  } catch (err) {
    return { error: err.message }
  }
}

const notify = async ({ userId, type = 'info', title, message, channel = 'email', phone, email }) => {
  const record = await insert('notifications', {
    user: userId,
    type,
    title,
    message,
    read: false,
    channels: { email: { sent: false }, sms: { sent: false } },
  })

  const emailResult = { sent: false }
  const smsResult = { sent: false }

  if ((channel === 'email' || channel === 'both') && email) {
    const res = await sendEmail({ to: email, subject: `SmartQueue - ${title}`, html: `<p>${escapeHtml(message)}</p>`, text: message })
    emailResult.sent = !res.skipped && !res.error
    if (emailResult.sent) {
      emailResult.sentAt = new Date()
      emailResult.messageId = res.messageId
    } else {
      emailResult.error = res.error || (res.skipped ? 'Email delivery is not configured.' : 'Email delivery failed.')
      console.error(`[notification] Email was not sent to ${email}: ${emailResult.error}`)
    }
  }

  if ((channel === 'sms' || channel === 'both') && phone) {
    const res = await sendSMS({ to: phone, body: `SmartQueue: ${title} - ${message}` })
    smsResult.sent = !res.skipped && !res.error
    smsResult.sentAt = new Date()
  }

  await updateById('notifications', record.id, { channels: { email: emailResult, sms: smsResult } })
  return { ...record, channels: { email: emailResult, sms: smsResult } }
}

const templates = {
  ticketConfirmed: ({ ticketNumber, estimatedWait, branchName, serviceName }) => ({
    type: 'success',
    title: 'Queue Ticket Confirmed',
    message: `Your ticket ${ticketNumber} for ${serviceName} at ${branchName} is confirmed. Estimated wait: ${estimatedWait} minutes.`,
  }),
  milestone5: ({ ticketNumber }) => ({ type: 'info', title: '5 People Ahead', message: `Ticket ${ticketNumber}: 5 people are ahead of you.` }),
  milestone2: ({ ticketNumber }) => ({ type: 'warning', title: 'Almost Your Turn!', message: `Ticket ${ticketNumber}: Only 2 people ahead.` }),
  ticketCalled: ({ ticketNumber, counterName }) => ({ type: 'success', title: "It's Your Turn!", message: `Ticket ${ticketNumber} - please proceed to ${counterName} now.` }),
  ticketServed: ({ ticketNumber }) => ({ type: 'success', title: 'Service Complete', message: `Ticket ${ticketNumber} - your session is complete.` }),
  ticketNoShow: ({ ticketNumber }) => ({ type: 'warning', title: 'Marked as No-Show', message: `Ticket ${ticketNumber} was marked as no-show.` }),
}

module.exports = { notify, sendEmail, sendQueueTicketEmail, sendSMS, templates }
