/**
 * Lightweight, MongoDB-backed indexing state machine.
 *
 * HTTP handlers only enqueue or control jobs. The actual Gemini calls run in
 * this service, polled by the in-process worker. Only one job runs at a time.
 */

const mongoose = require('mongoose')
const { Product } = require('../../modals/product.modal')
const VisualSearchJob = require('../../modals/visualSearchJob.modal')
const { config } = require('../../config/visualSearch.config')
const { readProductImage, normalizeForEmbedding } = require('./imageValidation.service')
const { embedImage } = require('./geminiEmbedding.service')
const {
  EMBEDDING_VERSION,
  resolveProductImageRefs,
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
    if (existing) return existing
    return newJob({ type: 'product', queue: [productId], force, reason })
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
          total: catalogStats.catalogImages,
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

module.exports = {
  ACTIVE_STATUSES,
  queueProductForIndexing,
  startIndexing,
  pauseIndexing,
  resumeIndexing,
  cancelIndexing,
  removeProductFromIndex,
  runSweep,
  recoverStaleJobs,
  getJobStatus,
  getCatalogStats,
}
