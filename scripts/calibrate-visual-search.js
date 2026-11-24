/**
 * Measure real Gemini image-embedding scores and latency against your catalog.
 *
 * Usage:
 *   npm run verify:visual-search
 *
 * Set VISUAL_SEARCH_CALIBRATION_SAMPLES (default 10) to control cost.
 * This script uses the configured GEMINI_API_KEY and may incur API charges.
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const {Product} = require('../modals/product.modal')
require('../modals/category.modal')
require('../modals/review.modal')
const {config, isConfigured} = require('../config/visualSearch.config')
const {readProductImage, normalizeForEmbedding} = require('../services/visualSearch/imageValidation.service')
const {embedImage} = require('../services/visualSearch/geminiEmbedding.service')
const {searchSimilarProducts, cosineSimilarity} = require('../services/visualSearch/similarity.service')
const {resolveProductImageRefs} = require('../services/visualSearch/embedding.store')
const VisualSearchEmbedding = require('../modals/visualSearchEmbedding.modal')

const sampleSize = Number.parseInt(process.env.VISUAL_SEARCH_CALIBRATION_SAMPLES || '10', 10)

const median = (values) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const p95 = (values) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

const main = async () => {
  if (!isConfigured()) {
    throw new Error('Visual search is disabled or GEMINI_API_KEY is missing.')
  }
  await mongoose.connect(process.env.DBHOST)

  const targetSamples = Number.isFinite(sampleSize) && sampleSize > 0 ? sampleSize : 10
  // Some legacy image URLs no longer exist; inspect a wider pool and stop once
  // we have enough usable samples.
  const products = await Product.find({'images.0': {$exists: true}})
    .sort({_id: 1})
    .limit(Math.max(60, targetSamples * 10))
    .lean()

  if (!products.length) {
    console.log('No products with images were found.')
    return
  }

  const indexedCount = await VisualSearchEmbedding.countDocuments({status: 'active'})
  if (!indexedCount) {
    console.warn('WARNING: no active embeddings found. Run admin batch indexing before calibrating.')
  }

  const latencies = []
  const topScores = []
  const selfScores = []
  const rows = []

  const uploadsDir = path.join(__dirname, '..', 'uploads', 'products')
  const assetBase = String(process.env.VISUAL_SEARCH_ASSET_BASE_URL || '').trim()
  const hasLocalFile = (ref) =>
    fs.existsSync(path.join(uploadsDir, path.basename(decodeURIComponent(ref.split('?')[0]))))

  // Prefer images that are actually present on disk. Many legacy remote URLs
  // return HTML fallbacks, so they are only used if local samples are scarce.
  const candidates = []
  const remoteCandidates = []
  for (const product of products) {
    const refs = await resolveProductImageRefs(product)
    const localRef = refs.find(hasLocalFile)
    if (localRef) {
      candidates.push({product, ref: localRef})
      continue
    }
    if (assetBase && refs.length) remoteCandidates.push({product, ref: refs[0]})
  }
  candidates.push(...remoteCandidates.slice(0, Math.max(0, targetSamples - candidates.length)))

  if (!candidates.length) {
    console.log('No readable product images were found.')
    return
  }

  for (const {product, ref: usableRef} of candidates) {
    if (rows.length >= targetSamples) break
    const started = Date.now()
    try {
      const bytes = await readProductImage(usableRef)
      const normalized = await normalizeForEmbedding(bytes, null)
      const embedding = await embedImage(normalized.buffer, normalized.mimeType)
      const result = await searchSimilarProducts(embedding.values, {})

      const stored = await VisualSearchEmbedding.findOne({
        productId: product._id,
        imageUrl: usableRef,
        status: 'active',
      }).lean()
      const selfScore = stored ? cosineSimilarity(embedding.values, stored.embedding) : null
      const topScore = result.results[0]?.similarityScore ?? null

      if (selfScore !== null) selfScores.push(selfScore)
      if (topScore !== null) topScores.push(topScore)
      latencies.push(Date.now() - started)
      rows.push({
        productId: String(product._id),
        image: usableRef,
        selfScore: selfScore === null ? null : Number(selfScore.toFixed(4)),
        topScore: topScore === null ? null : Number(topScore.toFixed(4)),
        topProductId: result.results[0]?.id || null,
        candidates: result.candidateCount,
        latencyMs: Date.now() - started,
      })
      console.log(`✓ ${product.name || product._id}`)
    } catch (error) {
      console.warn(`✗ ${product._id}: ${error.message}`)
    }
  }

  console.log('\n=== Visual search calibration summary ===')
  console.log(JSON.stringify({
    model: config.model,
    dimensions: config.dimensions,
    currentThreshold: config.search.minScore,
    indexedImages: indexedCount,
    samples: rows.length,
    latencyMs: {median: median(latencies), p95: p95(latencies)},
    score: {
      sameImageMedian: median(selfScores),
      bestMatchMedian: median(topScores),
      bestMatchP95: p95(topScores),
    },
  }, null, 2))
  console.log('\nPer-sample rows:')
  console.log(JSON.stringify(rows, null, 2))
  console.log(
    '\nGuidance: set VISUAL_SEARCH_MIN_COSINE_SCORE between typical unrelated best-match scores and same-product scores, then re-test with customer-style images.'
  )
}

main()
  .catch((error) => {
    console.error(`Calibration failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {})
  })
