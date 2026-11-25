/**
 * Image validation and normalization for visual search.
 *
 * Customer uploads stay in memory (multer memoryStorage) and are never written
 * to disk. Product images are read one at a time from the existing local upload
 * directory (or fetched one at a time from the configured asset host).
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const sharp = require('sharp')
const { config } = require('../../config/visualSearch.config')

class ImageValidationError extends Error {
  constructor(message, code = 'INVALID_IMAGE', status = 400) {
    super(message)
    this.name = 'ImageValidationError'
    this.code = code
    this.status = status
  }
}

const SIGNATURES = [
  {
    mime: 'image/jpeg',
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    matches: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    matches: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
]

const signatureMime = (buffer) => SIGNATURES.find((s) => s.matches(buffer))?.mime || null

/**
 * Validate an uploaded image, then normalize it to a small JPEG.
 * Gemini Embedding 2 documents PNG/JPEG input on the Gemini Developer API, so
 * WEBP and large images are converted locally with the already-installed sharp.
 */
const normalizeForEmbedding = async (buffer, declaredMimeType) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageValidationError('No image data was received.')
  }
  if (buffer.length > config.upload.maxBytes) {
    throw new ImageValidationError('The image is too large.', 'IMAGE_TOO_LARGE', 413)
  }

  const detectedMime = signatureMime(buffer)
  if (!detectedMime) {
    throw new ImageValidationError('The file is not a valid JPG, PNG, or WEBP image.')
  }
  if (!config.upload.allowedMimeTypes.includes(detectedMime)) {
    throw new ImageValidationError('This image format is not supported.')
  }
  if (
    declaredMimeType &&
    declaredMimeType !== detectedMime &&
    !(detectedMime === 'image/jpeg' && ['image/jpg', 'image/pjpeg'].includes(declaredMimeType))
  ) {
    throw new ImageValidationError('The file type does not match its contents.')
  }

  let output
  try {
    output = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .resize({
        width: config.upload.maxPixels,
        height: config.upload.maxPixels,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: config.upload.jpegQuality, mozjpeg: true })
      .toBuffer()
  } catch (error) {
    throw new ImageValidationError('The image could not be read. Please try another image.')
  }

  const metadata = await sharp(output).metadata()
  return {
    buffer: output,
    mimeType: 'image/jpeg',
    width: metadata.width,
    height: metadata.height,
    hash: crypto.createHash('sha256').update(output).digest('hex'),
  }
}

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads', 'products')

/**
 * Resolve a stored product image reference against the configured asset host.
 * The base may be an origin (`https://example.com`) or the `/uploads` root
 * (`https://example.com/uploads`). Product files live under `/uploads/products`.
 */
const buildAssetUrl = (imageRef, assetBase) => {
  const ref = String(imageRef || '').trim()
  const base = String(assetBase || '').trim().replace(/\/+$/, '')
  if (!ref || !base) return ''

  const [pathname, query] = ref.split('?')
  let relative = pathname.replace(/^\/+/, '')
  if (relative.toLowerCase().startsWith('uploads/')) {
    relative = relative.slice('uploads/'.length)
  }
  if (!relative.toLowerCase().startsWith('products/')) {
    relative = `products/${relative}`
  }

  const basePath = base.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '')
  const prefix = /\/uploads$/i.test(basePath) ? base : `${base}/uploads`
  return `${prefix}/${relative}${query ? `?${query}` : ''}`
}

const readRemoteImage = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeouts.imageFetch)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {'User-Agent': 'compiledEcommerce-visual-search/1.0'},
    })
    if (!response.ok) {
      throw new ImageValidationError('Product image could not be downloaded.', 'IMAGE_FETCH_FAILED', 502)
    }
    const contentType = String(response.headers.get('content-type') || '')
    if (contentType && !/^image\/(jpe?g|png|webp)/i.test(contentType)) {
      throw new ImageValidationError('Product image URL did not return an image.', 'IMAGE_FETCH_FAILED', 502)
    }
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (error instanceof ImageValidationError) throw error
    throw new ImageValidationError('Product image could not be downloaded.', 'IMAGE_FETCH_FAILED', 502)
  } finally {
    clearTimeout(timer)
  }
}

/** Read one product image. Local files are preferred; remote URLs are fetched one at a time. */
const readProductImage = async (imageRef) => {
  if (typeof imageRef !== 'string' || !imageRef.trim()) {
    throw new ImageValidationError('Product image reference is missing.', 'MISSING_IMAGE', 404)
  }

  const ref = imageRef.trim()
  const fileName = path.basename(decodeURIComponent(ref.split('?')[0]))

  if (/^https?:\/\//i.test(ref)) return readRemoteImage(ref)

  try {
    return await fs.readFile(path.join(UPLOADS_DIR, fileName))
  } catch (error) {
    const assetBase = String(process.env.VISUAL_SEARCH_ASSET_BASE_URL || '').trim()
    if (assetBase) {
      const assetUrl = buildAssetUrl(ref, assetBase)
      if (assetUrl) {
        try {
          return await readRemoteImage(assetUrl)
        } catch (_) {
          // Fall through to the original missing-file error.
        }
      }
    }
    throw new ImageValidationError('Product image file is missing.', 'MISSING_IMAGE', 404)
  }
}

module.exports = {
  ImageValidationError,
  normalizeForEmbedding,
  readProductImage,
  signatureMime,
  buildAssetUrl,
}
