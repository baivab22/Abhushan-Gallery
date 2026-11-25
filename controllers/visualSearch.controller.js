const mongoose = require('mongoose')
const { config, isConfigured, publicSettings } = require('../config/visualSearch.config')
const { normalizeForEmbedding, ImageValidationError } = require('../services/visualSearch/imageValidation.service')
const { embedImage, GeminiEmbeddingError } = require('../services/visualSearch/geminiEmbedding.service')
const { searchSimilarProducts, searchIndexedProduct } = require('../services/visualSearch/similarity.service')
const indexer = require('../services/visualSearch/indexer.service')
const { deleteProductEmbeddings } = require('../services/visualSearch/embedding.store')

const sendError = (res, status, message, code) =>
  res.status(status).json({ success: false, message, ...(code ? { code } : {}) })

exports.getStatus = async (_req, res) => {
  res.status(200).json({ success: true, data: publicSettings() })
}

/**
 * Customer-facing visual search.
 * multipart/form-data, field name: image
 */
exports.visualSearch = async (req, res) => {
  try {
    if (!isConfigured()) {
      return sendError(res, 503, 'Visual search is not available right now.', 'DISABLED')
    }
    if (!req.file?.buffer) {
      return sendError(res, 400, 'Please choose an image to search with.', 'NO_IMAGE')
    }

    const normalized = await normalizeForEmbedding(req.file.buffer, req.file.mimetype)
    const embedding = await embedImage(normalized.buffer, normalized.mimeType)
    const result = await searchSimilarProducts(embedding.values, req.body || {})

    return res.status(200).json({
      success: true,
      message: result.results.length
        ? `${result.results.length} visually similar product(s) found.`
        : 'No visually similar products were found. Try a clearer product photo.',
      data: {
        ...result,
        queryImage: {
          width: normalized.width,
          height: normalized.height,
          mimeType: normalized.mimeType,
        },
      },
    })
  } catch (error) {
    if (error instanceof ImageValidationError || error instanceof GeminiEmbeddingError) {
      return sendError(res, error.status || 502, error.message, error.code)
    }
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'The image is too large.', 'IMAGE_TOO_LARGE')
    }
    console.error('[visual-search] search failed:', error.message)
    return sendError(res, 500, 'Visual search could not be completed. Please try again.', 'SEARCH_FAILED')
  }
}

/* =========================
   ADMIN INDEXING CONTROLLERS
   ========================= */

exports.getAdminStatus = async (_req, res) => {
  try {
    const status = await indexer.getJobStatus()
    res.status(200).json({ success: true, data: status })
  } catch (error) {
    console.error('[visual-search] status failed:', error.message)
    sendError(res, 500, 'Could not load indexing status.', 'STATUS_FAILED')
  }
}

exports.getProducts = async (req, res) => {
  try {
    const data = await indexer.getProductIndexStatus(req.query || {})
    res.status(200).json({ success: true, data })
  } catch (error) {
    console.error('[visual-search] product list failed:', error.message)
    sendError(res, 500, 'Could not load the product indexing list.', 'PRODUCT_LIST_FAILED')
  }
}

/**
 * Admin diagnostic: search with a product's own indexed image.
 * Uses exactly the same stored vectors and ranking as the customer camera search.
 */
exports.testProductSearch = async (req, res) => {
  try {
    const { productId } = req.params
    if (!mongoose.isValidObjectId(productId)) {
      return sendError(res, 400, 'A valid product ID is required.')
    }
    const result = await searchIndexedProduct(productId, req.body || {})
    if (result.error === 'PRODUCT_NOT_FOUND') {
      return sendError(res, 404, 'Product not found.', 'PRODUCT_NOT_FOUND')
    }
    if (result.error === 'NOT_INDEXED') {
      return sendError(res, 409, 'This product has no active embedding. Index it before testing.', 'NOT_INDEXED')
    }
    return res.status(200).json({
      success: true,
      message: result.results.length
        ? `${result.results.length} visually similar product(s) found.`
        : 'No visually similar products were found for this image.',
      data: result,
    })
  } catch (error) {
    console.error('[visual-search] product test failed:', error.message)
    sendError(res, 500, 'Could not run visual search for this product.', 'TEST_FAILED')
  }
}

exports.startIndexing = async (req, res) => {
  try {
    if (!isConfigured()) {
      return sendError(res, 503, 'Visual search is not configured on the server.', 'NOT_CONFIGURED')
    }
    const body = req.body || {}
    const mode = ['index', 'reindex', 'product'].includes(String(body.mode)) ? String(body.mode) : 'index'
    const productIds = Array.isArray(body.productIds)
      ? body.productIds.filter((id) => mongoose.isValidObjectId(String(id)))
      : []
    const job = await indexer.startIndexing({
      mode,
      productIds,
      requestedBy: req.user?.userId || null,
    })
    res.status(202).json({
      success: true,
      message: 'Indexing job queued.',
      data: { id: String(job._id), status: job.status, type: job.type },
    })
  } catch (error) {
    if (error?.status === 400 || error?.status === 409) {
      return sendError(res, error.status, error.message)
    }
    console.error('[visual-search] could not start indexing:', error.message)
    sendError(res, 500, 'Could not start indexing.', 'START_FAILED')
  }
}

exports.pauseIndexing = async (_req, res) => {
  try {
    const job = await indexer.pauseIndexing()
    res.status(200).json({ success: true, message: 'Indexing paused.', data: { id: String(job._id), status: job.status } })
  } catch (error) {
    sendError(res, error?.status || 500, error.message)
  }
}

exports.resumeIndexing = async (_req, res) => {
  try {
    const job = await indexer.resumeIndexing()
    res.status(200).json({ success: true, message: 'Indexing resumed.', data: { id: String(job._id), status: job.status } })
  } catch (error) {
    sendError(res, error?.status || 500, error.message)
  }
}

exports.cancelIndexing = async (_req, res) => {
  try {
    const job = await indexer.cancelIndexing()
    res.status(200).json({ success: true, message: 'Indexing cancelled.', data: { id: String(job._id), status: job.status } })
  } catch (error) {
    sendError(res, error?.status || 500, error.message)
  }
}

exports.reindexProduct = async (req, res) => {
  try {
    const { productId } = req.params
    if (!mongoose.isValidObjectId(productId)) {
      return sendError(res, 400, 'A valid product ID is required.')
    }
    const job = await indexer.startIndexing({
      mode: 'reindex',
      productIds: [productId],
      requestedBy: req.user?.userId || null,
    })
    res.status(202).json({ success: true, message: 'Product reindex queued.', data: { id: String(job._id) } })
  } catch (error) {
    if (error?.status === 400 || error?.status === 409) return sendError(res, error.status, error.message)
    console.error('[visual-search] reindex failed:', error.message)
    sendError(res, 500, 'Could not queue product reindex.', 'REINDEX_FAILED')
  }
}

exports.deleteProductEmbeddings = async (req, res) => {
  try {
    const { productId } = req.params
    if (!mongoose.isValidObjectId(productId)) {
      return sendError(res, 400, 'A valid product ID is required.')
    }
    const result = await deleteProductEmbeddings(productId)
    await indexer.removeProductFromIndex(productId)
    res.status(200).json({
      success: true,
      message: 'Product embeddings removed.',
      data: { deletedCount: result.deletedCount || 0 },
    })
  } catch (error) {
    console.error('[visual-search] embedding delete failed:', error.message)
    sendError(res, 500, 'Could not remove product embeddings.', 'DELETE_FAILED')
  }
}

exports.getFailures = async (_req, res) => {
  try {
    const status = await indexer.getJobStatus()
    res.status(200).json({ success: true, data: { failures: status.job?.failures || [] } })
  } catch (error) {
    sendError(res, 500, 'Could not load indexing failures.', 'FAILURES_FAILED')
  }
}
