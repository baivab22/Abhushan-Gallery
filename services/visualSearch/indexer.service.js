/**
 * Lightweight, MongoDB-backed indexing state machine.
 *
 * HTTP handlers only enqueue or control jobs. The actual Gemini calls run in
 * this service, polled by the in-process worker. Only one job runs at a time.
 */

const mongoose = require('mongoose')
const { Product } = require('../../modals/product.modal')
const VisualSearchJob = require('../../modals/visualSearchJob.modal')
const VisualSearchEmbedding = require('../../modals/visualSearchEmbedding.modal')
const { config } = require('../../config/visualSearch.config')
const { readProductImage, normalizeForEmbedding } = require('./imageValidation.service')
const { embedImage } = require('./geminiEmbedding.service')
const {
  EMBEDDING_VERSION,
  resolveProductImageRefs,
  resolveProductImageRefsBulk,
  shouldGenerate,
  upsertEmbedding,
  markEmbeddingFailed,
  deleteProductEmbeddings,
  deleteStaleEmbeddings,
  getStats,
} = require('./embedding.store')

const ACTIVE_STATUSES = ['queued', 'running', 'paused']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let sweepRunning = false

const newJob = async (payload) =>
  VisualSearchJob.create({
    ...payload,
    status: 'queued',
    batchSize: config.indexer.batchSize,
    delayMs: config.indexer.batchDelayMs,
  })

/** Schedule one product after create/update/image changes. Reuses a pending product job. */
const queueProductForIndexing = async (productId, { reason = 'product change', force = false } = {}) => {
  if (!productId) return null
  try {
    const existing = await VisualSearchJob.findOneAndUpdate(
      { status: 'queued', type: 'product', force },
      {
        $addToSet: { queue: productId },
        $set: { reason, updatedAt: new Date() },
      },
      { new: true }
    )
    if (existing) {
      kickIndexer()
      return existing
    }
    const job = await newJob({ type: 'product', queue: [productId], force, reason })
    kickIndexer()
    return job
  } catch (error) {
    console.error('[visual-search] could not queue product:', error.message)
    return null
  }
}

const startIndexing = async ({ mode = 'full', productIds = [], requestedBy = null } = {}) => {
  const active = await VisualSearchJob.findOne({ status: { $in: ACTIVE_STATUSES } }).sort({ createdAt: -1 })
  const force = mode === 'reindex'
  const type = productIds.length ? 'product' : force ? 'reindex' : 'full'

  if (active && type !== 'product') {
    const error = new Error('An indexing job is already active. Pause or cancel it first.')
    error.status = 409
    throw error
  }
  if (type === 'product' && (!productIds.length || !productIds.every((id) => mongoose.isValidObjectId(id)))) {
    const error = new Error('Valid product IDs are required.')
    error.status = 400
    throw error
  }

  return newJob({
    type,
    force,
    queue: productIds,
    reason: force ? 'reindex requested' : 'batch indexing requested',
    requestedBy,
  })
}

const setJobStatus = async (status) => {
  const job = await VisualSearchJob.findOneAndUpdate(
    { status: { $in: ['queued', 'running', 'paused'] } },
    { $set: { status, lastFinishedAt: status === 'cancelled' ? new Date() : undefined } },
    { sort: { createdAt: -1 }, new: true }
  )
  if (!job) {
    const error = new Error('No active indexing job was found.')
    error.status = 404
    throw error
  }
  return job
}

const pauseIndexing = () => setJobStatus('paused')
const resumeIndexing = () => setJobStatus('queued')
const cancelIndexing = () => setJobStatus('cancelled')

const removeProductFromIndex = async (productId) => {
  await Promise.all([
    deleteProductEmbeddings(productId),
    VisualSearchJob.updateMany(
      { status: { $in: ['queued', 'paused'] } },
      { $pull: { queue: productId } }
    ),
  ])
}

const claimJob = () =>
  VisualSearchJob.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running', lastStartedAt: new Date(), lastError: null } },
    { sort: { createdAt: 1 }, new: true }
  )

const recoverStaleJobs = async () => {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000)
  const result = await VisualSearchJob.updateMany(
    { status: 'running', lastStartedAt: { $lt: cutoff } },
    { $set: { status: 'queued', lastError: 'Recovered after worker restart.' } }
  )
  return result.modifiedCount || 0
}

const nextProducts = async (job) => {
  if (job.type === 'full' || job.type === 'reindex') {
    const query = job.cursorId ? { _id: { $gt: job.cursorId } } : {}
    const products = await Product.find(query).sort({ _id: 1 }).limit(job.batchSize || 5).lean()
    return {
      products,
      cursorId: products.length ? products[products.length - 1]._id : null,
      remainingQueue: job.queue,
    }
  }

  const batchIds = (job.queue || []).slice(0, job.batchSize || 5)
  if (!batchIds.length) return { products: [], cursorId: job.cursorId, remainingQueue: [] }
  const products = await Product.find({ _id: { $in: batchIds } }).lean()
  return {
    products,
    cursorId: job.cursorId,
    remainingQueue: (job.queue || []).slice(batchIds.length),
  }
}

const processProduct = async (product, { force }) => {
  const refs = await resolveProductImageRefs(product)
  let succeeded = 0
  let failed = 0
  const failures = []

  for (const imageUrl of refs) {
    try {
      let normalized
      try {
        const bytes = await readProductImage(imageUrl)
        normalized = await normalizeForEmbedding(bytes, null)
      } catch (error) {
        failed += 1
        failures.push({ productId: product._id, imageUrl, message: error.message, at: new Date() })
        continue
      }

      if (!(await shouldGenerate({ productId: product._id, imageUrl, imageHash: normalized.hash, force }))) {
        continue
      }

      try {
        const embedding = await embedImage(normalized.buffer, normalized.mimeType)
        await upsertEmbedding({
          productId: product._id,
          imageUrl,
          imageHash: normalized.hash,
          values: embedding.values,
        })
        succeeded += 1
      } catch (error) {
        failed += 1
        failures.push({ productId: product._id, imageUrl, message: error.message, at: new Date() })
        try {
          await markEmbeddingFailed({
            productId: product._id,
            imageUrl,
            imageHash: normalized.hash,
            message: error.message,
          })
        } catch (storeError) {
          console.error('[visual-search] failed to record embedding error:', storeError.message)
        }
      }
    } catch (error) {
      failed += 1
      failures.push({ productId: product._id, imageUrl, message: error.message, at: new Date() })
    }
  }

  const removed = await deleteStaleEmbeddings(product._id, refs)
  return { succeeded, failed, removed, failures }
}

/** Process at most one batch. Safe to call from setInterval. */
const runSweep = async () => {
  if (sweepRunning) return { skipped: true }
  sweepRunning = true
  try {
    // Also recover here, not only at boot: a process that stays alive must not
    // leave a crashed job stuck in `running` and block all future indexing.
    await recoverStaleJobs()
    const job = await claimJob()
    if (!job) return { processed: false }

    const { products, cursorId, remainingQueue } = await nextProducts(job)
    if (!products.length) {
      await VisualSearchJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'completed',
            lastFinishedAt: new Date(),
            cursorId: null,
            queue: [],
          },
        }
      )
      return { completed: true, jobId: job._id }
    }

    let succeeded = 0
    let failed = 0
    const failures = []
    for (const product of products) {
      const result = await processProduct(product, { force: Boolean(job.force) })
      succeeded += result.succeeded
      failed += result.failed
      failures.push(...result.failures)
    }

    // Product jobs have no cursor, so finish them in the same sweep that drains
    // their queue. Otherwise no future sweep would ever re-claim this job.
    const done = job.type === 'product' ? remainingQueue.length === 0 : !cursorId

    await VisualSearchJob.updateOne(
      { _id: job._id },
      {
        $set: {
          cursorId,
          queue: remainingQueue,
          processed: (job.processed || 0) + products.length,
          succeeded: (job.succeeded || 0) + succeeded,
          failed: (job.failed || 0) + failed,
          ...(done ? { status: 'completed', lastFinishedAt: new Date() } : {}),
        },
        $push: failures.length
          ? { failures: { $each: failures.slice(0, 50), $slice: -200 } }
          : {},
      }
    )

    if (job.delayMs && !done) await sleep(job.delayMs)
    return { processed: products.length, succeeded, failed, completed: done, jobId: job._id }
  } catch (error) {
    console.error('[visual-search] indexing sweep failed:', error.message)
    await VisualSearchJob.updateOne(
      { status: 'running' },
      { $set: { status: 'failed', lastFinishedAt: new Date(), lastError: String(error.message).slice(0, 500) } }
    ).catch(() => {})
    return { error: error.message }
  } finally {
    sweepRunning = false
  }
}

let kickScheduled = false

/**
 * Start a sweep on the next tick so a product added from the dashboard is
 * indexed right away instead of waiting for the next worker poll. The timer in
 * the worker stays as the fallback for queued jobs and post-restart recovery.
 */
const kickIndexer = () => {
  if (kickScheduled) return
  kickScheduled = true
  setImmediate(async () => {
    kickScheduled = false
    try {
      await runSweep()
    } catch (error) {
      console.error('[visual-search] indexing kick failed:', error.message)
    }
  })
}

const getCatalogStats = async () => {
  const [productCount, imageAgg] = await Promise.all([
    Product.countDocuments({}),
    Product.aggregate([
      {
        $project: {
          n: {
            $sum: {
              $map: {
                input: { $ifNull: ['$images', []] },
                as: 'variant',
                in: {
                  $add: [
                    { $size: { $ifNull: ['$$variant.coloredImages', []] } },
                    {
                      $cond: [
                        { $isArray: { $ifNull: ['$$variant.coloredImages', []] } },
                        0,
                        { $cond: [{ $gt: ['$$variant.coloredImage', null] }, 1, 0] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalImages: { $sum: '$n' },
          productsWithImages: { $sum: { $cond: [{ $gt: ['$n', 0] }, 1, 0] } },
        },
      },
    ]),
  ])
  return {
    totalProducts: productCount,
    catalogImages: imageAgg[0]?.totalImages || 0,
    productsWithImages: imageAgg[0]?.productsWithImages || 0,
  }
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A product is usable by customer visual search only when at least one of its
 * current images has an active embedding for the active model/dimensions.
 */
const deriveProductIndexStatus = ({ imageCount, activeCount, failedCount }) => {
  if (!imageCount) return 'no-images'
  if (activeCount >= imageCount) return 'indexed'
  if (activeCount > 0) return 'partial'
  if (failedCount > 0) return 'failed'
  return 'pending'
}

/**
 * Paginated per-product indexing overview for the admin dashboard. Embeddings
 * from an older model/version/dimension are ignored because search ignores them.
 */
const getProductIndexStatus = async ({ page = 1, limit = 20, status = 'all', search = '' } = {}) => {
  const parsedPage = Number.parseInt(page, 10)
  const parsedLimit = Number.parseInt(limit, 10)
  const safeLimit = Math.min(100, Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20)
  const match = {}
  const term = String(search || '').trim()
  if (term) match.name = { $regex: escapeRegExp(term), $options: 'i' }

  const [products, groups] = await Promise.all([
    Product.find(match)
      .select('name images price discountedPrice stockQuantity updatedAt')
      .sort({ name: 1 })
      .lean(),
    VisualSearchEmbedding.aggregate([
      {
        $match: {
          embeddingModel: config.model,
          embeddingVersion: EMBEDDING_VERSION,
          dimensions: config.dimensions,
        },
      },
      { $sort: { updatedAt: -1 } },
      {
        $group: {
          _id: '$productId',
          activeCount: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          failedCount: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          lastIndexedAt: { $max: { $cond: [{ $eq: ['$status', 'active'] }, '$updatedAt', null] } },
          lastError: {
            $max: { $cond: [{ $eq: ['$status', 'failed'] }, '$lastError', null] },
          },
        },
      },
    ]),
  ])

  const byProduct = new Map(groups.map((row) => [String(row._id), row]))
  const refsByProduct = await resolveProductImageRefsBulk(products)
  const all = products.map((product) => {
    const refs = refsByProduct.get(String(product._id)) || []
    const group = byProduct.get(String(product._id)) || {}
    const imageCount = refs.length
    const activeCount = group.activeCount || 0
    const failedCount = group.failedCount || 0
    return {
      id: String(product._id),
      name: product.name || 'Untitled product',
      image: refs[0] || null,
      price: product.price ?? null,
      discountedPrice: product.discountedPrice ?? null,
      stockQuantity: product.stockQuantity ?? null,
      imageCount,
      indexedImages: activeCount,
      failedImages: failedCount,
      pendingImages: Math.max(0, imageCount - activeCount - failedCount),
      status: deriveProductIndexStatus({ imageCount, activeCount, failedCount }),
      searchable: activeCount > 0,
      lastIndexedAt: group.lastIndexedAt || null,
      lastError: group.lastError || null,
    }
  })

  const countStatus = (value) => all.filter((item) => item.status === value).length
  const summary = {
    total: all.length,
    searchable: all.filter((item) => item.searchable).length,
    indexed: countStatus('indexed'),
    partial: countStatus('partial'),
    pending: countStatus('pending'),
    failed: countStatus('failed'),
    noImages: countStatus('no-images'),
  }

  const wanted = String(status || 'all')
  const filtered =
    wanted === 'all'
      ? all
      : wanted === 'searchable'
        ? all.filter((item) => item.searchable)
        : all.filter((item) => item.status === wanted)
  const total = filtered.length
  const pages = Math.max(1, Math.ceil(total / safeLimit))
  const safePage = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, pages) : 1

  return {
    items: filtered.slice((safePage - 1) * safeLimit, safePage * safeLimit),
    pagination: { page: safePage, limit: safeLimit, total, pages },
    summary,
  }
}

const getJobStatus = async () => {
  const [job, embeddingStats, catalogStats] = await Promise.all([
    VisualSearchJob.findOne().sort({ createdAt: -1 }).lean(),
    getStats(),
    getCatalogStats(),
  ])
  const pendingImages = Math.max(0, catalogStats.catalogImages - embeddingStats.activeImages)
  return {
    job: job
      ? {
          id: String(job._id),
          type: job.type,
          status: job.status,
          reason: job.reason,
          total: catalogStats.productsWithImages,
          processed: job.processed || 0,
          succeeded: job.succeeded || 0,
          failed: job.failed || 0,
          queueLength: (job.queue || []).length,
          lastStartedAt: job.lastStartedAt,
          lastFinishedAt: job.lastFinishedAt,
          lastError: job.lastError,
          failures: (job.failures || []).slice(-20),
        }
      : null,
    totalProducts: catalogStats.totalProducts,
    productsWithImages: catalogStats.productsWithImages,
    totalIndexedImages: embeddingStats.activeImages,
    pendingImages,
    failedImages: job?.failed || 0,
    lastIndexingTime: job?.lastFinishedAt || job?.lastStartedAt || null,
    embeddingStats,
    model: config.model,
    embeddingVersion: EMBEDDING_VERSION,
    dimensions: config.dimensions,
  }
}

/**
 * Image-level overview: every embedding that visual search can actually use
 * (or that failed to become usable) for the active model/version/dimensions.
 */
const getImageIndexStatus = async ({
  page = 1,
  limit = 20,
  status = 'active',
  search = '',
  productId = '',
} = {}) => {
  const parsedPage = Number.parseInt(page, 10)
  const parsedLimit = Number.parseInt(limit, 10)
  const safeLimit = Math.min(100, Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20)
  const query = {
    embeddingModel: config.model,
    embeddingVersion: EMBEDDING_VERSION,
    dimensions: config.dimensions,
  }
  const wanted = ['all', 'active', 'failed', 'missing'].includes(String(status)) ? String(status) : 'active'
  if (wanted !== 'all') query.status = wanted

  if (mongoose.isValidObjectId(String(productId || ''))) {
    query.productId = new mongoose.Types.ObjectId(String(productId))
  }

  const term = String(search || '').trim()
  if (term) {
    const escaped = escapeRegExp(term)
    const or = [{ imageUrl: { $regex: escaped, $options: 'i' } }]
    const matchingProducts = await Product.find({ name: { $regex: escaped, $options: 'i' } })
      .select('_id')
      .lean()
    if (matchingProducts.length) {
      or.push({ productId: { $in: matchingProducts.map((product) => product._id) } })
    }
    if (mongoose.isValidObjectId(term)) or.push({ productId: new mongoose.Types.ObjectId(term) })
    query.$or = or
  }

  const [total, docs, summaryRows] = await Promise.all([
    VisualSearchEmbedding.countDocuments(query),
    VisualSearchEmbedding.find(query)
      .sort({ updatedAt: -1 })
      .skip((Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage - 1 : 0) * safeLimit)
      .limit(safeLimit)
      .lean(),
    VisualSearchEmbedding.aggregate([
      {
        $match: {
          embeddingModel: config.model,
          embeddingVersion: EMBEDDING_VERSION,
          dimensions: config.dimensions,
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ])

  const productIds = [...new Set(docs.map((doc) => String(doc.productId)))]
  const products = await Product.find({ _id: { $in: productIds } }).select('name').lean()
  const productNames = new Map(products.map((product) => [String(product._id), product.name]))

  const items = docs.map((doc) => ({
    id: String(doc._id),
    productId: String(doc.productId),
    productName: productNames.get(String(doc.productId)) || 'Unknown product',
    imageUrl: doc.imageUrl,
    status: doc.status,
    searchable: doc.status === 'active',
    model: doc.embeddingModel,
    version: doc.embeddingVersion,
    dimensions: doc.dimensions,
    imageHash: doc.imageHash || null,
    lastError: doc.lastError || null,
    indexedAt: doc.updatedAt || doc.createdAt || null,
  }))

  const pages = Math.max(1, Math.ceil(total / safeLimit))
  const safePage = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, pages) : 1
  const summary = { all: 0, active: 0, failed: 0, missing: 0 }
  for (const row of summaryRows) summary[row._id] = row.count
  summary.all = summaryRows.reduce((sum, row) => sum + row.count, 0)

  return {
    items,
    pagination: { page: safePage, limit: safeLimit, total, pages },
    summary,
  }
}

module.exports = {
  ACTIVE_STATUSES,
  queueProductForIndexing,
  startIndexing,
  pauseIndexing,
  resumeIndexing,
  cancelIndexing,
  removeProductFromIndex,
  runSweep,
  kickIndexer,
  recoverStaleJobs,
  getJobStatus,
  getCatalogStats,
  getProductIndexStatus,
  getImageIndexStatus,
  deriveProductIndexStatus,
}
