/**
 * Gemini Embedding 2 REST client.
 *
 * All embedding work happens on Google's infrastructure. No ML model, weights,
 * or runtime is installed on this server. The API key is read from the backend
 * environment only and is never returned to the client.
 */

const axios = require('axios')
const { config } = require('../../config/visualSearch.config')

const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:embedContent`

class GeminiEmbeddingError extends Error {
  constructor(message, code = 'GEMINI_ERROR', status = 502) {
    super(message)
    this.name = 'GeminiEmbeddingError'
    this.code = code
    this.status = status
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const l2Normalize = (values) => {
  if (!Array.isArray(values) || values.length === 0) return null
  let sum = 0
  for (const value of values) {
    if (!Number.isFinite(value)) return null
    sum += value * value
  }
  if (!Number.isFinite(sum) || sum === 0) return null
  const norm = Math.sqrt(sum)
  return values.map((value) => value / norm)
}

const classifyError = (error) => {
  const status = error?.response?.status
  const code = error?.code || error?.response?.data?.error?.status
  const message = String(error?.response?.data?.error?.message || error?.message || '')

  if (status === 429 || code === 'RESOURCE_EXHAUSTED') {
    const quotaExhausted = /quota|daily limit|requests per day|rpd/i.test(message)
    return new GeminiEmbeddingError(
      quotaExhausted ? 'The embedding API quota is exhausted.' : 'The embedding API is rate limiting requests.',
      quotaExhausted ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED',
      429
    )
  }
  if (status === 403 || code === 'PERMISSION_DENIED') {
    return new GeminiEmbeddingError('Embedding API access is not configured.', 'API_FORBIDDEN', 502)
  }
  if (status >= 500 || ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL'].includes(code)) {
    return new GeminiEmbeddingError('The embedding service is temporarily unavailable.', 'API_UNAVAILABLE', 502)
  }
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) {
    return new GeminiEmbeddingError('The embedding service timed out.', 'API_TIMEOUT', 504)
  }
  if (status === 400 || status === 404) {
    return new GeminiEmbeddingError('The embedding request was rejected.', 'API_BAD_REQUEST', 502)
  }
  return new GeminiEmbeddingError('The embedding service could not be reached.', 'API_ERROR', 502)
}

const isRetryable = (error) =>
  ['RATE_LIMITED', 'API_UNAVAILABLE', 'API_TIMEOUT', 'API_ERROR'].includes(error?.code)

/**
 * Generate one normalized image embedding.
 * @param {Buffer} imageBuffer normalized JPEG bytes
 * @param {string} mimeType image MIME type
 * @param {{client?: any, signal?: AbortSignal}} options injectable for tests
 * @returns {Promise<{values: number[], model: string, dimensions: number}>}
 */
const embedImage = async (imageBuffer, mimeType = 'image/jpeg', options = {}) => {
  if (!config.apiKey) {
    throw new GeminiEmbeddingError('Visual search is not configured.', 'NOT_CONFIGURED', 503)
  }
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new GeminiEmbeddingError('No image bytes were provided.', 'EMPTY_IMAGE', 400)
  }

  const client = options.client || axios
  const body = {
    content: {
      parts: [
        {
          inline_data: {
            mime_type: mimeType,
            data: imageBuffer.toString('base64'),
          },
        },
      ],
    },
    output_dimensionality: config.dimensions,
  }

  let lastError
  for (let attempt = 0; attempt <= config.retries.max; attempt += 1) {
    try {
      const response = await client.post(API_URL, body, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        timeout: config.timeouts.gemini,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        signal: options.signal,
        validateStatus: (status) => status >= 200 && status < 300,
      })

      // Live Gemini Developer API returns `embedding.values`. Some SDK versions
      // wrap this as `embeddings[0].values`, so accept both shapes.
      const rawValues = response?.data?.embedding?.values || response?.data?.embeddings?.[0]?.values
      const values = l2Normalize(rawValues)
      if (!values || values.length !== config.dimensions) {
        throw new GeminiEmbeddingError(
          'The embedding service returned an invalid vector.',
          'INVALID_RESPONSE',
          502
        )
      }
      return { values, model: config.model, dimensions: config.dimensions }
    } catch (error) {
      lastError = error instanceof GeminiEmbeddingError ? error : classifyError(error)
      if (!isRetryable(lastError) || attempt === config.retries.max) break
      const backoff = config.retries.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250)
      await sleep(backoff)
    }
  }
  throw lastError || new GeminiEmbeddingError('Embedding generation failed.', 'GEMINI_ERROR', 502)
}

module.exports = {
  GeminiEmbeddingError,
  embedImage,
  l2Normalize,
  API_URL,
}
