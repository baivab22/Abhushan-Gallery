const mongoose = require('mongoose')

/**
 * Durable, lightweight job state for product image indexing.
 * The worker polls this collection; indexing never runs inside an HTTP request.
 */
const visualSearchJobSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['full', 'reindex', 'product'],
      default: 'full',
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    reason: {
      type: String,
      default: null,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Explicit product IDs for product/reindex jobs. Full jobs use cursorId.
    queue: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
    cursorId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    force: {
      type: Boolean,
      default: false,
    },
    batchSize: {
      type: Number,
      default: 5,
    },
    delayMs: {
      type: Number,
      default: 1500,
    },
    total: {
      type: Number,
      default: 0,
    },
    processed: {
      type: Number,
      default: 0,
    },
    succeeded: {
      type: Number,
      default: 0,
    },
    failed: {
      type: Number,
      default: 0,
    },
    failures: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        imageUrl: { type: String, default: null },
        message: { type: String, default: '' },
        at: { type: Date, default: Date.now },
      },
    ],
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
)

visualSearchJobSchema.index({ status: 1, createdAt: 1 })

const VisualSearchJob =
  mongoose.models.VisualSearchJob || mongoose.model('VisualSearchJob', visualSearchJobSchema)

module.exports = VisualSearchJob
