const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const mongoose = require('mongoose')

const {config} = require('../config/visualSearch.config')
const {
  normalizeForEmbedding,
  signatureMime,
  ImageValidationError,
  buildAssetUrl,
} = require('../services/visualSearch/imageValidation.service')
const {GeminiEmbeddingError} = require('../services/visualSearch/geminiEmbedding.service')
const {cosineSimilarity, aggregateScores, buildProductQuery} = require('../services/visualSearch/similarity.service')
const {getProductImageRefs} = require('../services/visualSearch/embedding.store')
const {deriveProductIndexStatus} = require('../services/visualSearch/indexer.service')
const {visualSearchRateLimit} = require('../middlewares/visualSearchRateLimit')
const {requireAdmin} = require('../auth')

const makePng = () =>
  sharp({
    create: {width: 24, height: 24, channels: 3, background: {r: 220, g: 40, b: 40}},
  })
    .png()
    .toBuffer()

test('image signature validation accepts real PNG/JPEG/WEBP bytes and rejects text', async () => {
  const png = await makePng()
  assert.equal(signatureMime(png), 'image/png')

  const jpeg = await sharp(png).jpeg().toBuffer()
  assert.equal(signatureMime(jpeg), 'image/jpeg')

  const webp = await sharp(png).webp().toBuffer()
  assert.equal(signatureMime(webp), 'image/webp')

  assert.equal(signatureMime(Buffer.from('not an image')), null)
  await assert.rejects(
    normalizeForEmbedding(Buffer.from('not an image'), 'image/png'),
    ImageValidationError
  )
})

test('normalizeForEmbedding resizes and converts images to bounded JPEG bytes', async () => {
  const largePng = await sharp({
    create: {width: 2200, height: 1600, channels: 3, background: {r: 10, g: 90, b: 200}},
  })
    .png()
    .toBuffer()

  const normalized = await normalizeForEmbedding(largePng, 'image/png')
  assert.equal(normalized.mimeType, 'image/jpeg')
  assert.ok(normalized.width <= config.upload.maxPixels)
  assert.ok(normalized.height <= config.upload.maxPixels)
  assert.equal(signatureMime(normalized.buffer), 'image/jpeg')
  assert.match(normalized.hash, /^[a-f0-9]{64}$/)
})

test('image MIME spoofing is rejected', async () => {
  const png = await makePng()
  await assert.rejects(
    normalizeForEmbedding(png, 'image/jpeg'),
    (error) => error instanceof ImageValidationError && /does not match/.test(error.message)
  )
})

test('cosine similarity is bounded and not a percentage', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9)
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9)
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0)
  assert.ok(cosineSimilarity([1, 0], [-1, 0]) < -0.99)
})

test('aggregateScores deduplicates images by product and keeps the best match', async () => {
  const query = [1, 0, 0, 0]
  const embeddings = [
    {productId: 'p1', imageUrl: 'a.jpg', embedding: [0.6, 0.8, 0, 0]},
    {productId: 'p1', imageUrl: 'b.jpg', embedding: [0.95, 0.3, 0, 0]},
    {productId: 'p2', imageUrl: 'c.jpg', embedding: [0.8, 0.6, 0, 0]},
    {productId: 'p3', imageUrl: 'd.jpg', embedding: [0, 1, 0, 0]},
  ]

  const ranked = await aggregateScores(query, embeddings, {minScore: 0.5, limit: 10})
  assert.deepEqual(
    ranked.map((row) => String(row.productId)),
    ['p1', 'p2']
  )
  assert.equal(ranked[0].matchedImage, 'b.jpg')
  assert.ok(ranked[0].score > ranked[1].score)
  assert.ok(ranked.every((row) => row.score <= 1 && row.score >= -1))
})

test('aggregateScores applies threshold and limit', async () => {
  const query = [1, 0]
  const embeddings = [
    {productId: 'p1', embedding: [1, 0]},
    {productId: 'p2', embedding: [0.9, Math.sqrt(1 - 0.81)]},
    {productId: 'p3', embedding: [0, 1]},
  ]
  const ranked = await aggregateScores(query, embeddings, {minScore: 0.85, limit: 1})
  assert.equal(ranked.length, 1)
  assert.equal(String(ranked[0].productId), 'p1')
})

test('product query supports category, price, stock and status filters', () => {
  const categoryId = new mongoose.Types.ObjectId()
  const query = buildProductQuery({
    categoryId: String(categoryId),
    minPrice: '100',
    maxPrice: '500',
    inStock: 'true',
  })
  assert.equal(String(query.category), String(categoryId))
  assert.equal(query.stockQuantity.$gt, 0)
  assert.ok(query.$or.some((part) => part.price?.$gte === 100))
  assert.ok(query.$or.some((part) => part.discountedPrice?.$lte === 500))

  assert.deepEqual(buildProductQuery({category: 'not-an-id', status: 'out_of_stock'}), {
    stockQuantity: {$lte: 0},
  })
  assert.deepEqual(buildProductQuery({inStock: 'all'}), {})
})

test('product image refs support coloredImages arrays and legacy coloredImage fields', () => {
  const legacyId = new mongoose.Types.ObjectId()
  const refs = getProductImageRefs({
    images: [
      {coloredImages: ['one.jpg', 'two.jpg']},
      {coloredImage: 'three.jpg'},
      {coloredImages: ['one.jpg']},
      String(legacyId),
      legacyId,
    ],
  })
  assert.deepEqual(refs, [
    'one.jpg',
    'two.jpg',
    'three.jpg',
    String(legacyId),
  ])
})

test('remote product image URLs are built from origin or /uploads asset bases', () => {
  assert.equal(
    buildAssetUrl('/uploads/products/photo.jpg', 'https://example.com'),
    'https://example.com/uploads/products/photo.jpg'
  )
  assert.equal(
    buildAssetUrl('photo.jpg', 'https://example.com/uploads/'),
    'https://example.com/uploads/products/photo.jpg'
  )
  assert.equal(
    buildAssetUrl('/uploads/products/photo.jpg?v=2', 'https://example.com/uploads'),
    'https://example.com/uploads/products/photo.jpg?v=2'
  )
})

test('per-product index status distinguishes indexed, partial, failed and pending', () => {
  assert.equal(deriveProductIndexStatus({imageCount: 0, activeCount: 0, failedCount: 0}), 'no-images')
  assert.equal(deriveProductIndexStatus({imageCount: 2, activeCount: 2, failedCount: 0}), 'indexed')
  assert.equal(deriveProductIndexStatus({imageCount: 2, activeCount: 1, failedCount: 0}), 'partial')
  assert.equal(deriveProductIndexStatus({imageCount: 2, activeCount: 0, failedCount: 1}), 'failed')
  assert.equal(deriveProductIndexStatus({imageCount: 2, activeCount: 0, failedCount: 0}), 'pending')
})

test('rate limiter blocks requests over the configured per-minute limit', () => {
  const originalMax = config.rateLimit.max
  config.rateLimit.max = 2
  const req = {headers: {'x-forwarded-for': '203.0.113.77'}, socket: {remoteAddress: '127.0.0.1'}}
  const result = {}
  const res = {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    set(key, value) {
      this.headers[key] = value
      return this
    },
    json(payload) {
      result.payload = payload
      return this
    },
  }

  try {
    let nextCount = 0
    const next = () => {
      nextCount += 1
    }
    visualSearchRateLimit(req, res, next)
    visualSearchRateLimit(req, res, next)
    visualSearchRateLimit(req, res, next)

    assert.equal(nextCount, 2)
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['Retry-After'], '60')
    assert.equal(result.payload.success, false)
  } finally {
    config.rateLimit.max = originalMax
  }
})

test('admin guard rejects non-admin users and allows admins', () => {
  const response = () => ({
    statusCode: 200,
    status(code) {
      this.statusCode = code
      return this
    },
    json() {
      return this
    },
  })

  const userRes = response()
  let userNextCalled = false
  requireAdmin({user: {userId: '1', role: 'USER'}}, userRes, () => {
    userNextCalled = true
  })
  assert.equal(userRes.statusCode, 403)
  assert.equal(userNextCalled, false)

  const adminRes = response()
  let adminNextCalled = false
  requireAdmin({user: {userId: '1', role: 'ADMIN'}}, adminRes, () => {
    adminNextCalled = true
  })
  assert.equal(adminNextCalled, true)
})

test('Gemini client retries 429 and validates embedding dimensions', async () => {
  const originalKey = config.apiKey
  const originalDimensions = config.dimensions
  const originalRetries = config.retries.max
  const originalBase = config.retries.baseDelayMs
  config.apiKey = 'test-key'
  config.dimensions = 4
  config.retries.max = 2
  config.retries.baseDelayMs = 1

  const {embedImage} = require('../services/visualSearch/geminiEmbedding.service')
  let calls = 0
  const fakeClient = {
    post: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('rate limited')
        error.response = {status: 429, data: {error: {message: 'Rate limit exceeded'}}}
        throw error
      }
      return {data: {embeddings: [{values: [3, 0, 4, 0]}]}}
    },
  }

  try {
    const result = await embedImage(Buffer.from('image-bytes'), 'image/jpeg', {client: fakeClient})
    assert.equal(calls, 2)
    assert.equal(result.values.length, 4)
    assert.ok(Math.abs(Math.hypot(...result.values) - 1) < 1e-9)
    assert.equal(result.model, config.model)
  } finally {
    config.apiKey = originalKey
    config.dimensions = originalDimensions
    config.retries.max = originalRetries
    config.retries.baseDelayMs = originalBase
  }
})

test('Gemini client accepts the live singular embedding response shape', async () => {
  const originalKey = config.apiKey
  const originalDimensions = config.dimensions
  const originalRetries = config.retries.max
  config.apiKey = 'test-key'
  config.dimensions = 4
  config.retries.max = 0

  const {embedImage} = require('../services/visualSearch/geminiEmbedding.service')
  const fakeClient = {post: async () => ({data: {embedding: {values: [0, 3, 4, 0]}}})}

  try {
    const result = await embedImage(Buffer.from('image-bytes'), 'image/jpeg', {client: fakeClient})
    assert.equal(result.values.length, 4)
    assert.ok(Math.abs(Math.hypot(...result.values) - 1) < 1e-9)
  } finally {
    config.apiKey = originalKey
    config.dimensions = originalDimensions
    config.retries.max = originalRetries
  }
})

test('Gemini client rejects invalid embedding responses', async () => {
  const originalKey = config.apiKey
  const originalDimensions = config.dimensions
  const originalRetries = config.retries.max
  config.apiKey = 'test-key'
  config.dimensions = 4
  config.retries.max = 0

  const {embedImage} = require('../services/visualSearch/geminiEmbedding.service')
  const fakeClient = {post: async () => ({data: {embeddings: [{values: [1, 0, 0]}]}})}

  try {
    await assert.rejects(
      embedImage(Buffer.from('image-bytes'), 'image/jpeg', {client: fakeClient}),
      (error) => error instanceof GeminiEmbeddingError && error.code === 'INVALID_RESPONSE'
    )
  } finally {
    config.apiKey = originalKey
    config.dimensions = originalDimensions
    config.retries.max = originalRetries
  }
})

test('queueing a new product starts an indexing sweep without a manual run', async () => {
  const indexer = require('../services/visualSearch/indexer.service')
  const VisualSearchJob = require('../modals/visualSearchJob.modal')
  const VisualSearchEmbedding = require('../modals/visualSearchEmbedding.modal')
  const {Product} = require('../modals/product.modal')

  const originals = {
    findOneAndUpdate: VisualSearchJob.findOneAndUpdate,
    create: VisualSearchJob.create,
    updateMany: VisualSearchJob.updateMany,
    updateOne: VisualSearchJob.updateOne,
    productFind: Product.find,
    embeddingDeleteMany: VisualSearchEmbedding.deleteMany,
  }

  const productId = new mongoose.Types.ObjectId()
  const jobId = new mongoose.Types.ObjectId()
  let findOneAndUpdateCalls = 0
  let sweepClaimedJob = false
  let finalStatus = null

  try {
    VisualSearchJob.findOneAndUpdate = async (filter) => {
      findOneAndUpdateCalls += 1
      if (findOneAndUpdateCalls === 1) {
        assert.equal(filter.type, 'product')
        return null
      }
      sweepClaimedJob = true
      return {
        _id: jobId,
        type: 'product',
        status: 'running',
        force: false,
        batchSize: 5,
        delayMs: 0,
        queue: [productId],
        cursorId: null,
        processed: 0,
        succeeded: 0,
        failed: 0,
      }
    }
    VisualSearchJob.create = async (payload) => {
      assert.equal(payload.type, 'product')
      assert.deepEqual(payload.queue.map(String), [String(productId)])
      return {...payload, _id: jobId, status: 'queued', batchSize: 5, delayMs: 0}
    }
    VisualSearchJob.updateMany = async () => ({modifiedCount: 0})
    VisualSearchJob.updateOne = async (_filter, update) => {
      if (update?.$set?.status) finalStatus = update.$set.status
      return {modifiedCount: 1}
    }
    Product.find = () => ({lean: async () => []})
    VisualSearchEmbedding.deleteMany = async () => ({deletedCount: 0})

    const job = await indexer.queueProductForIndexing(productId, {reason: 'product created'})
    assert.equal(job.type, 'product')

    for (let attempt = 0; attempt < 50 && !finalStatus; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    assert.equal(sweepClaimedJob, true)
    assert.equal(finalStatus, 'completed')
  } finally {
    VisualSearchJob.findOneAndUpdate = originals.findOneAndUpdate
    VisualSearchJob.create = originals.create
    VisualSearchJob.updateMany = originals.updateMany
    VisualSearchJob.updateOne = originals.updateOne
    Product.find = originals.productFind
    VisualSearchEmbedding.deleteMany = originals.embeddingDeleteMany
  }
})
