/**
 * Small in-memory fixed-window limiter for the public visual-search endpoint.
 * Suitable for a single Node process; no Redis or extra service required.
 */

const { config } = require('../config/visualSearch.config')

const buckets = new Map()

const clientKey = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.ip ||
  req.socket?.remoteAddress ||
  'unknown'

const visualSearchRateLimit = (req, res, next) => {
  const now = Date.now()
  const key = clientKey(req)
  const current = buckets.get(key)

  if (!current || now >= current.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + config.rateLimit.windowMs })
    return next()
  }

  if (current.count >= config.rateLimit.max) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    res.set('Retry-After', String(retryAfter))
    return res.status(429).json({
      success: false,
      message: 'Too many visual searches. Please try again shortly.',
    })
  }

  current.count += 1
  return next()
}

// Prevent unbounded growth on long-running servers.
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of buckets.entries()) {
    if (now >= value.resetAt) buckets.delete(key)
  }
}, Math.max(config.rateLimit.windowMs, 60_000)).unref?.()

module.exports = { visualSearchRateLimit }
