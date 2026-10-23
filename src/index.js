require('dotenv').config()

const express = require('express')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { Server } = require('socket.io')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const rateLimit = require('express-rate-limit')
const connectDB = require('./config/db')
const errorHandler = require('./middleware/errorHandler')

const authRoutes = require('./routes/auth')
const queueRoutes = require('./routes/queue')
const branchRoutes = require('./routes/branches')
const counterRoutes = require('./routes/counters')
const userRoutes = require('./routes/users')
const notifRoutes = require('./routes/notifications')
const analyticsRoutes = require('./routes/analytics')
const setupSocket = require('./socket')

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const app = express()
const server = http.createServer(app)
let dbReady = false
const dbConnectPromise = connectDB()

const DEFAULT_CLIENT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://smartqueues-chi.vercel.app',
]

const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, '')

const CLIENT_ORIGINS = (process.env.CLIENT_URLS || process.env.CLIENT_URL || '')
  .split(',')
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean)

if (!CLIENT_ORIGINS.length) {
  CLIENT_ORIGINS.push(...DEFAULT_CLIENT_ORIGINS)
}

const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

// Shared by Express and Socket.IO. In development any localhost port is allowed.
const checkOrigin = (origin, callback) => {
  if (!origin) return callback(null, true)
  const norm = normalizeOrigin(origin)
  if (CLIENT_ORIGINS.includes(norm)) return callback(null, true)
  if (!IS_PRODUCTION && LOCAL_DEV_ORIGIN.test(norm)) return callback(null, true)
  return callback(new Error(`CORS blocked for origin: ${origin}`))
}

const io = new Server(server, {
  cors: { origin: checkOrigin, methods: ['GET', 'POST'], credentials: true },
})

setupSocket(io)
app.set('io', io)
// Behind Render/Vercel-style proxies the client IP is in X-Forwarded-For (needed by the rate limiter).
if (IS_PRODUCTION) app.set('trust proxy', 1)

app.use(helmet())
app.use(cors({ origin: checkOrigin, credentials: true }))
app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

const healthPayload = () => ({
  status: 'ok',
  dbReady,
  backend: 'supabase',
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
  env: process.env.NODE_ENV || 'development',
})

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'SmartQueue backend is running.' })
})
app.get(['/health', '/api/health', '/api/health/db'], (req, res) => res.json(healthPayload()))

app.use('/api', async (req, res, next) => {
  if (dbReady) return next()
  try {
    dbReady = Boolean(await dbConnectPromise)
  } catch {
    dbReady = false
  }
  if (dbReady) return next()
  return res.status(503).json({
    message: 'Database is not connected yet. Please try again shortly.',
    dbReady: false,
  })
})

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
}))

// Only credential endpoints get the strict limit, so /auth/me polling can't lock users out.
app.use(['/api/auth/login', '/api/auth/register', '/api/auth/change-password'], rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many auth attempts. Try again in 15 minutes.' },
}))

app.use('/api/auth', authRoutes)
app.use('/api/queue', queueRoutes)
app.use('/api/branches', branchRoutes)
app.use('/api/counters', counterRoutes)
app.use('/api/users', userRoutes)
app.use('/api/notifications', notifRoutes)
app.use('/api/analytics', analyticsRoutes)

app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found.` })
})

app.use(errorHandler)

const PORT = Number(process.env.PORT || 5000)
const HOST = '0.0.0.0'
// Hopping to the next free port is a local-dev convenience; in production a busy port is a real error.
const MAX_PORT_ATTEMPTS = IS_PRODUCTION ? 0 : Number(process.env.PORT_RETRY_COUNT || 10)
// Read by smartqueue/vite.config.js so the dev proxy follows the port actually in use.
const PORT_FILE = path.join(__dirname, '../.cache/backend-port.json')

const publishPort = (port) => {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true })
    fs.writeFileSync(
      PORT_FILE,
      JSON.stringify({ port, host: '127.0.0.1', url: `http://127.0.0.1:${port}`, updatedAt: new Date().toISOString() }, null, 2)
    )
  } catch (err) {
    console.warn(`Unable to write backend port file: ${err.message}`)
  }
}

const startServer = (port, attempt = 0) => {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
      const nextPort = port + 1
      console.warn(`Port ${port} is already in use. Trying ${nextPort} instead (${attempt + 1}/${MAX_PORT_ATTEMPTS}).`)
      startServer(nextPort, attempt + 1)
      return
    }

    console.error(`Failed to start server on port ${port}:`, err.message)
    process.exit(1)
  }

  server.once('error', onError)
  server.listen(port, HOST, () => {
    server.off('error', onError)
    const address = server.address()
    const actualPort = address && typeof address === 'object' ? address.port : port
    if (!IS_PRODUCTION) publishPort(actualPort)
    console.log(`SmartQueue server running on http://127.0.0.1:${actualPort}`)
    console.log(`Socket.IO ready - allowed client origins: ${CLIENT_ORIGINS.join(', ')}`)
    if (actualPort !== PORT) {
      console.warn(`Requested port ${PORT} was unavailable, so the server switched to ${actualPort}.`)
    }
  })
}

startServer(PORT)

dbConnectPromise
  .then((ok) => {
    dbReady = Boolean(ok)
    if (!dbReady) console.warn('SmartQueue started without a database connection.')
  })
  .catch((err) => {
    console.error('Database initialization error:', err.message)
    dbReady = false
  })
