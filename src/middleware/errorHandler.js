const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.stack || err.message)

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ message: 'Invalid token.' })
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Token expired.' })
  }

  // Postgres constraint errors are caused by the request, not the server.
  const PG_ERRORS = {
    23503: [409, 'This record is still linked to other data and cannot be changed or removed.'],
    23505: [409, 'A record with these details already exists.'],
    23514: [400, 'One of the values is not allowed.'],
    '22P02': [400, 'Invalid id or value format.'],
  }
  if (PG_ERRORS[err.code]) {
    const [pgStatus, pgMessage] = PG_ERRORS[err.code]
    return res.status(pgStatus).json({ message: pgMessage })
  }

  const status = err.statusCode || err.status || 500
  res.status(status).json({
    message: err.message || 'Internal server error.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
}

module.exports = errorHandler
