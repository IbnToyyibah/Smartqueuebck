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

const isAllowedOrigin = (origin) => CLIENT_ORIGINS.includes(origin)

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (isAllowedOrigin(normalizeOrigin(origin))) return callback(null, true)
    return callback(new Error(`CORS blocked for origin: ${origin}`))
  },
  credentials: true,
}

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

setupSocket(io)
app.set('io', io)

app.use(helmet())
app.use(cors(corsOptions))
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'SmartQueue backend is running.',
  })
})

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    dbReady,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  })
})

app.use('/api', async (req, res, next) => {
  if (req.path === '/health') return next()
  if (dbReady) return next()
  try {
    const ok = await dbConnectPromise
    dbReady = Boolean(ok)
    if (dbReady) return next()
    return res.status(503).json({
      message: 'Database is not connected yet. Please try again shortly.',
      dbReady: false,
    })
  } catch (err) {
    return res.status(503).json({
      message: 'Database is not connected yet. Please try again shortly.',
      dbReady: false,
    })
  }
})

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
})
app.use('/api', limiter)

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: 'Too many auth attempts. Try again in 15 minutes.' },
})
app.use('/api/auth', authLimiter)

app.use('/api/auth', authRoutes)
app.use('/api/queue', queueRoutes)
app.use('/api/branches', branchRoutes)
app.use('/api/counters', counterRoutes)
app.use('/api/users', userRoutes)
app.use('/api/notifications', notifRoutes)
app.use('/api/analytics', analyticsRoutes)

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    dbReady,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  })
})

app.get('/api/health/db', (req, res) => {
  res.json({
    dbReady,
    backend: 'supabase',
  })
})

app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found.` })
})

app.use(errorHandler)

const PORT = process.env.PORT || 5000
const HOST = '0.0.0.0'
const MAX_PORT_ATTEMPTS = Number(process.env.PORT_RETRY_COUNT || 10)
const PORT_FILE = path.join(__dirname, '../../.cache/backend-port.json')

const publishPort = (port) => {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true })
    fs.writeFileSync(
      PORT_FILE,
      JSON.stringify(
        {
          port,
          host: '127.0.0.1',
          url: `http://127.0.0.1:${port}`,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    )
  } catch (err) {
    console.warn(`Unable to write backend port file: ${err.message}`)
  }
}

const startServer = (port, attempt = 0) => {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
      const nextPort = Number(port) + 1
      console.warn(
        `Port ${port} is already in use. Trying ${nextPort} instead (${attempt + 1}/${MAX_PORT_ATTEMPTS}).`
      )
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
    publishPort(actualPort)
    console.log(`SmartQueue server running on http://127.0.0.1:${actualPort}`)
    console.log(`Socket.IO ready - allowed client origins: ${CLIENT_ORIGINS.join(', ')}`)
    if (actualPort !== Number(PORT)) {
      console.warn(`Requested port ${PORT} was unavailable, so the server switched to ${actualPort}.`)
    }
  })
}

startServer(PORT)

dbConnectPromise
  .then((ok) => {
    dbReady = Boolean(ok)
    if (!dbReady) {
      console.warn('SmartQueue started without a database connection.')
    }
  })
  .catch((err) => {
    console.error('Database initialization error:', err.message)
    dbReady = false
  })
