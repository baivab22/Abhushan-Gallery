/**
 * Configuration for Gemini-powered visual product search.
 *
 * All secrets stay on the server. Nothing in this module is sent to the client.
 */

const toInt = (value, fallback, min = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

const toBool = (value, fallback = true) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

// The previous contact-sheet implementation used a percentage score (0-100)
// under VISUAL_SEARCH_MIN_SCORE. Cosine similarity is -1..1, so ignore legacy
// out-of-range values instead of silently filtering out every result.
const rawMinScore =
  process.env.VISUAL_SEARCH_MIN_COSINE_SCORE ?? process.env.VISUAL_SEARCH_MIN_SCORE
const parsedMinScore = Number(rawMinScore)
const minScore =
  Number.isFinite(parsedMinScore) && parsedMinScore >= -1 && parsedMinScore <= 1
    ? parsedMinScore
    : 0
if (rawMinScore !== undefined && Number(rawMinScore) !== minScore) {
  console.warn(
    '[visual-search] Ignoring legacy/out-of-range score threshold; use VISUAL_SEARCH_MIN_COSINE_SCORE (-1 to 1).'
  )
}

const config = {
  enabled: toBool(process.env.VISUAL_SEARCH_ENABLED, true),
  apiKey: String(process.env.GEMINI_API_KEY || '').trim(),
  model: String(process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2').trim(),
  dimensions: toInt(process.env.VISUAL_SEARCH_OUTPUT_DIMENSIONALITY, 768, 128),

  upload: {
    maxBytes: toInt(process.env.VISUAL_SEARCH_MAX_UPLOAD_MB, 5, 1) * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxPixels: 1600,
    jpegQuality: 82,
  },

  rateLimit: {
    windowMs: toInt(process.env.VISUAL_SEARCH_RATE_WINDOW_MS, 60_000, 1000),
    max: toInt(process.env.VISUAL_SEARCH_RATE_LIMIT_PER_MIN, 12, 1),
  },

  timeouts: {
    gemini: toInt(process.env.VISUAL_SEARCH_TIMEOUT_MS, 20_000, 1000),
    imageFetch: toInt(process.env.VISUAL_SEARCH_IMAGE_TIMEOUT_MS, 8_000, 1000),
  },

  retries: {
    max: toInt(process.env.VISUAL_SEARCH_MAX_RETRIES, 3, 0),
    baseDelayMs: toInt(process.env.VISUAL_SEARCH_RETRY_BASE_MS, 750, 100),
  },

  search: {
    // Deliberately a new name: the old VISUAL_SEARCH_MAX_CANDIDATES=80 value
    // from the contact-sheet implementation is too small for embedding search.
    candidateLimit: toInt(process.env.VISUAL_SEARCH_CANDIDATE_LIMIT, 2000, 1),
    resultLimit: toInt(process.env.VISUAL_SEARCH_RESULT_LIMIT, 24, 1),
    // Cosine similarity is NOT a percentage. 0 keeps every ranked candidate and
    // lets the admin calibrate a real threshold with the calibration script.
    minScore,
  },

  indexer: {
    batchSize: toInt(process.env.VISUAL_SEARCH_BATCH_SIZE, 5, 1),
    batchDelayMs: toInt(process.env.VISUAL_SEARCH_BATCH_DELAY_MS, 1500, 0),
    pollIntervalMs: toInt(process.env.VISUAL_SEARCH_WORKER_INTERVAL_MS, 10_000, 1000),
  },
}

if (config.dimensions > 3072) config.dimensions = 3072

const isConfigured = () => config.enabled && Boolean(config.apiKey)

const publicSettings = () => ({
  enabled: config.enabled && isConfigured(),
  model: config.model,
  dimensions: config.dimensions,
  maxUploadMB: Math.round(config.upload.maxBytes / (1024 * 1024)),
  acceptedFormats: ['jpg', 'jpeg', 'png', 'webp'],
})

module.exports = { config, isConfigured, publicSettings }
