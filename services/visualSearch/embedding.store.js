const VisualSearchEmbedding = require('../../modals/visualSearchEmbedding.modal')
const { ProductImage } = require('../../modals/product.modal')
const { config } = require('../../config/visualSearch.config')

const EMBEDDING_VERSION = '1'

/** Extract every stored image reference from a product document (sync). */
const getProductImageRefs = (product) => {
  const refs = []
  const seen = new Set()
  if (!product || !Array.isArray(product.images)) return refs

  for (const variant of product.images) {
    const candidates = []
    if (typeof variant === 'string') {
      // Legacy ProductImage document ID — resolved below when needed.
      candidates.push(variant)
    } else if (variant && typeof variant === 'object' && variant._bsontype === 'ObjectId') {
      // mongoose .lean() keeps ObjectId values as BSON objects, not strings.
      candidates.push(String(variant))
    } else {
      if (Array.isArray(variant?.coloredImages)) candidates.push(...variant.coloredImages)
      if (typeof variant?.coloredImage === 'string') candidates.push(variant.coloredImage)
    }

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const ref = candidate.trim()
      if (!ref || seen.has(ref)) continue
      seen.add(ref)
      refs.push(ref)
    }
  }
  return refs
}

/**
 * Expand legacy ProductImage IDs for many products with one query.
 * Dashboard list views need resolved refs to report accurate image counts;
 * doing this per product would add hundreds of round trips.
 */
const resolveProductImageRefsBulk = async (products) => {
  const refsByProduct = new Map()
  const legacyIds = new Set()

  for (const product of products) {
    const refs = getProductImageRefs(product)
    refsByProduct.set(String(product._id), refs)
    for (const ref of refs) {
      if (/^[a-f\d]{24}$/i.test(ref)) legacyIds.add(ref)
    }
  }

  if (!legacyIds.size) return refsByProduct

  const legacyDocs = await ProductImage.find({ _id: { $in: [...legacyIds] } }).lean()
  const byId = new Map(legacyDocs.map((doc) => [String(doc._id), doc]))

  for (const [productId, refs] of refsByProduct) {
    const resolved = []
    const seen = new Set()
    for (const ref of refs) {
      const legacy = byId.get(ref)
      const values = legacy
        ? [
            ...(Array.isArray(legacy.coloredImages) ? legacy.coloredImages : []),
            ...(Array.isArray(legacy.coloredImage)
              ? legacy.coloredImage
              : typeof legacy.coloredImage === 'string'
                ? [legacy.coloredImage]
                : []),
          ]
        : [ref]

      for (const value of values) {
        if (typeof value !== 'string') continue
        const clean = value.trim()
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        resolved.push(clean)
      }
    }
    refsByProduct.set(productId, resolved)
  }

  return refsByProduct
}

/** Expand legacy ProductImage IDs into their actual image filenames. */
const resolveProductImageRefs = async (product) => {
  const refs = getProductImageRefs(product)
  const resolved = []
  const seen = new Set()

  for (const ref of refs) {
    const values = []
    if (/^[a-f\d]{24}$/i.test(ref)) {
      const legacy = await ProductImage.findById(ref).lean()
      if (legacy) {
        if (Array.isArray(legacy.coloredImages)) values.push(...legacy.coloredImages)
        if (Array.isArray(legacy.coloredImage)) values.push(...legacy.coloredImage)
        else if (typeof legacy.coloredImage === 'string') values.push(legacy.coloredImage)
      }
      if (!values.length) values.push(ref)
    } else {
      values.push(ref)
    }

    for (const value of values) {
      if (typeof value !== 'string') continue
      const clean = value.trim()
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      resolved.push(clean)
    }
  }
  return resolved
}

const shouldGenerate = async ({ productId, imageUrl, imageHash, force = false }) => {
  if (force) return true
  const existing = await VisualSearchEmbedding.findOne({ productId, imageUrl }).lean()
  if (!existing) return true
  if (
    existing.embeddingModel !== config.model ||
    existing.embeddingVersion !== EMBEDDING_VERSION ||
    existing.dimensions !== config.dimensions
  ) {
    return true
  }
  // A failed document must be retried by a normal indexing run. Otherwise a
  // temporary Gemini/image read failure would stay broken until a force reindex.
  if (existing.status !== 'active') return true
  return Boolean(imageHash && existing.imageHash && existing.imageHash !== imageHash)
}

const upsertEmbedding = async ({
  productId,
  imageUrl,
  imageHash,
  values,
  status = 'active',
  lastError = null,
}) => {
  const filter = { productId, imageUrl }
  const update = {
    $set: {
      imageHash: imageHash || null,
      embedding: values,
      embeddingModel: config.model,
      embeddingVersion: EMBEDDING_VERSION,
      dimensions: config.dimensions,
      status,
      lastError,
    },
  }
  return VisualSearchEmbedding.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  })
}

const markEmbeddingFailed = async ({ productId, imageUrl, imageHash, message }) =>
  upsertEmbedding({
    productId,
    imageUrl,
    imageHash,
    values: Array(config.dimensions).fill(0),
    status: 'failed',
    lastError: String(message || '').slice(0, 500),
  })

const deleteProductEmbeddings = async (productId) =>
  VisualSearchEmbedding.deleteMany({ productId })

const deleteStaleEmbeddings = async (productId, validRefs) => {
  const result = await VisualSearchEmbedding.deleteMany({
    productId,
    imageUrl: { $nin: validRefs },
  })
  return result.deletedCount || 0
}

const getStats = async () => {
  const [total, active, byStatus, byModel] = await Promise.all([
    VisualSearchEmbedding.countDocuments({}),
    VisualSearchEmbedding.countDocuments({ status: 'active' }),
    VisualSearchEmbedding.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    VisualSearchEmbedding.aggregate([
      {
        $group: {
          _id: { model: '$embeddingModel', version: '$embeddingVersion' },
          count: { $sum: 1 },
        },
      },
    ]),
  ])

  return {
    totalImages: total,
    activeImages: active,
    byStatus: byStatus.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
    byModel: byModel.map((row) => ({ ...row._id, count: row.count })),
  }
}

module.exports = {
  EMBEDDING_VERSION,
  getProductImageRefs,
  resolveProductImageRefs,
  resolveProductImageRefsBulk,
  shouldGenerate,
  upsertEmbedding,
  markEmbeddingFailed,
  deleteProductEmbeddings,
  deleteStaleEmbeddings,
  getStats,
}
