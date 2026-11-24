/**
 * In-process indexing worker.
 *
 * Uses one timer and a MongoDB-backed job state, so it fits the existing 2 GB
 * hosting environment. No queue service, no AI runtime, no large batch loads.
 */

const { config, isConfigured } = require('../config/visualSearch.config')
const indexer = require('../services/visualSearch/indexer.service')

const GLOBAL_KEY = '__compiledEcommerceVisualSearchWorker'

const startVisualSearchIndexWorker = () => {
  if (global[GLOBAL_KEY]) return global[GLOBAL_KEY]
  if (!isConfigured()) {
    console.log('[visual-search] worker disabled (VISUAL_SEARCH_ENABLED=false or missing GEMINI_API_KEY).')
    return null
  }

  indexer.recoverStaleJobs().catch((error) => {
    console.error('[visual-search] stale job recovery failed:', error.message)
  })

  const timer = setInterval(() => {
    indexer.runSweep().catch((error) => {
      console.error('[visual-search] indexing worker error:', error.message)
    })
  }, config.indexer.pollIntervalMs)

  global[GLOBAL_KEY] = timer
  console.log(
    `[visual-search] indexing worker started (batch=${config.indexer.batchSize}, poll=${config.indexer.pollIntervalMs}ms, model=${config.model}).`
  )
  return timer
}

module.exports = { startVisualSearchIndexWorker }
