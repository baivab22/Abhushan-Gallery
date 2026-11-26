/**
 * Similarity search over stored Gemini embeddings.
 *
 * The catalog is small (about 1.2k images), so cosine similarity is computed in
 * application code over a filtered candidate set. This needs no extra service,
 * no vector index, and only a few MB of transient memory.
 */

const mongoose = require('mongoose')
const { Product } = require('../../modals/product.modal')
const Review = require('../../modals/review.modal')
const VisualSearchEmbedding = require('../../modals/visualSearchEmbedding.modal')
const { config } = require('../../config/visualSearch.config')
const { EMBEDDING_VERSION } = require('./embedding.store')

/** Cosine similarity in [-1, 1]. It is not a percentage. */
const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i])
    const bv = Number(b[i])
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const toNumber = (value) => {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const toBoolean = (value) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['all', 'any'].includes(normalized)) return null
  return ['true', '1', 'yes', 'on'].includes(normalized)
}

const buildProductQuery = (filters = {}) => {
  const query = {}
  const objectIdFields = ['category', 'categoryId', 'subCategory', 'subCategoryId', 'nestedSubCategory', 'nestedSubCategoryId']
  const fieldMap = {
    category: 'category',
    categoryId: 'category',
    subCategory: 'subCategory',
    subCategoryId: 'subCategory',
    nestedSubCategory: 'nestedSubCategory',
    nestedSubCategoryId: 'nestedSubCategory',
  }
  for (const key of objectIdFields) {
    const value = filters[key]
    if (value && mongoose.isValidObjectId(String(value))) query[fieldMap[key]] = value
  }

  const minPrice = toNumber(filters.minPrice)
  const maxPrice = toNumber(filters.maxPrice)
  if (minPrice !== null || maxPrice !== null) {
    const priceRange = {}
    if (minPrice !== null) priceRange.$gte = minPrice
    if (maxPrice !== null) priceRange.$lte = maxPrice
    query.$or = [{ price: priceRange }, { discountedPrice: priceRange }]
  }

  const inStock = toBoolean(filters.inStock ?? filters.available)
  const status = String(filters.status || '').toLowerCase()
  if (inStock === true || status === 'active' || status === 'available') {
    query.stockQuantity = { $gt: 0 }
  } else if (inStock === false || status === 'out_of_stock') {
    query.stockQuantity = { $lte: 0 }
  }

  return query
}

const getRatings = async (productIds) => {
  if (!productIds.length) return new Map()
  const rows = await Review.aggregate([
    {
      $match: {
        product: { $in: productIds },
        status: 'APPROVED',
      },
    },
    {
      $group: {
        _id: '$product',
        averageRating: { $avg: '$rating' },
        reviewCount: { $sum: 1 },
      },
    },
  ])
  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        averageRating: Math.round((row.averageRating || 0) * 10) / 10,
        reviewCount: row.reviewCount,
      },
    ])
  )
}

/**
 * Aggregate image embeddings into one best score per product.
 * Accepts any iterable/async iterable of {productId, imageUrl, embedding}.
 */
const aggregateScores = async (queryVector, embeddings, options = {}) => {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : config.search.minScore
  const limit = Number.isFinite(options.limit) ? options.limit : config.search.resultLimit
  const scores = new Map()

  for await (const doc of embeddings) {
    const score = cosineSimilarity(queryVector, doc.embedding)
    const key = String(doc.productId)
    const current = scores.get(key)
    if (!current || score > current.score) {
      scores.set(key, { productId: doc.productId, score, matchedImage: doc.imageUrl })
    }
  }

  return [...scores.values()]
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Rank candidate products by the best matching image embedding.
 * @returns {Promise<{results: Array, candidateCount: number, model: string, embeddingVersion: string, threshold: number}>}
 */
const searchSimilarProducts = async (queryVector, filters = {}) => {
  const candidateQuery = buildProductQuery(filters)
  const candidates = await Product.find(candidateQuery)
    .select('name description price originalPrice discountedPrice discountPercentage images stockQuantity category subCategory nestedSubCategory isHotSelling isNewArrivals isBestSelling flashSale')
    .limit(config.search.candidateLimit)
    .lean()

  if (!candidates.length) {
    return { results: [], candidateCount: 0, model: config.model, embeddingVersion: EMBEDDING_VERSION, threshold: config.search.minScore }
  }

  const candidateIds = candidates.map((product) => product._id)

  const cursor = VisualSearchEmbedding.find({
    productId: { $in: candidateIds },
    embeddingModel: config.model,
    embeddingVersion: EMBEDDING_VERSION,
    dimensions: config.dimensions,
    status: 'active',
  })
    .select('productId imageUrl embedding')
    .lean()
    .cursor()

  const ranked = await aggregateScores(queryVector, cursor)

  if (!ranked.length) {
    return { results: [], candidateCount: candidates.length, model: config.model, embeddingVersion: EMBEDDING_VERSION, threshold: config.search.minScore }
  }

  const rankedIds = ranked.map((row) => row.productId)
  const [fullProducts, ratings] = await Promise.all([
    Product.find({ _id: { $in: rankedIds } })
      .populate('category')
      .populate('subCategory')
      .populate('nestedSubCategory')
      .lean(),
    getRatings(rankedIds),
  ])

  const byId = new Map(fullProducts.map((product) => [String(product._id), product]))
  const results = ranked
    .map((row) => {
      const product = byId.get(String(row.productId))
      if (!product) return null
      return {
        ...product,
        id: String(product._id),
        similarityScore: row.score,
        matchedImage: row.matchedImage,
        averageRating: ratings.get(String(row.productId))?.averageRating || 0,
        reviewCount: ratings.get(String(row.productId))?.reviewCount || 0,
      }
    })
    .filter(Boolean)

  return {
    results,
    candidateCount: candidates.length,
    model: config.model,
    embeddingVersion: EMBEDDING_VERSION,
    threshold: config.search.minScore,
  }
}

/**
 * Admin diagnostic: run the exact same ranking pipeline using an already
 * indexed product image instead of a customer upload.
 */
const searchIndexedProduct = async (productId, filters = {}) => {
  const { imageUrl, ...productFilters } = filters || {}
  const embeddingQuery = {
    productId,
    embeddingModel: config.model,
    embeddingVersion: EMBEDDING_VERSION,
    dimensions: config.dimensions,
    status: 'active',
  }
  if (imageUrl) embeddingQuery.imageUrl = String(imageUrl)

  const [product, embedding] = await Promise.all([
    Product.findById(productId).select('name images').lean(),
    VisualSearchEmbedding.findOne(embeddingQuery).select('embedding imageUrl').lean(),
  ])

  if (!product) return { error: 'PRODUCT_NOT_FOUND' }
  if (!embedding?.embedding?.length) {
    return { error: imageUrl ? 'IMAGE_NOT_INDEXED' : 'NOT_INDEXED' }
  }

  const result = await searchSimilarProducts(embedding.embedding, productFilters)
  return {
    ...result,
    queryImage: {
      productId: String(product._id),
      name: product.name || 'Untitled product',
      imageUrl: embedding.imageUrl,
    },
  }
}

module.exports = {
  cosineSimilarity,
  aggregateScores,
  buildProductQuery,
  searchSimilarProducts,
  searchIndexedProduct,
}
