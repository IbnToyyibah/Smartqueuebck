const nodemailer = require('nodemailer')
const { insert, updateById } = require('../lib/supabaseRepo')

const createTransport = () => {
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const host = process.env.SMTP_HOST
  if (!host || !user || !pass || user === 'your_email@gmail.com' || pass === 'your_gmail_app_password') return null
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  })
}

const getTwilio = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null
  const twilio = require('twilio')
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
}

const sendEmail = async ({ to, subject, html, text }) => {
  const transporter = createTransport()
  if (!transporter) return { skipped: true }
  try {
    await transporter.verify()
    const info = await transporter.sendMail({
      from: `"SmartQueue" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to, subject, html, text,
    })
    return { messageId: info.messageId }
  } catch (err) {
    return { error: err.message }
  }
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
    const res = await sendEmail({ to: email, subject: `SmartQueue - ${title}`, html: `<p>${message}</p>`, text: message })
    emailResult.sent = !res.skipped && !res.error
    emailResult.sentAt = new Date()
  }

  if ((channel === 'sms' || channel === 'both') && phone) {
    const res = await sendSMS({ to: phone, body: `SmartQueue: ${title} - ${message}` })
    smsResult.sent = !res.skipped && !res.error
    smsResult.sentAt = new Date()
  }

  await updateById('notifications', record.id, { channels: { email: emailResult, sms: smsResult } })
  return record
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

module.exports = { notify, sendEmail, sendSMS, templates }
