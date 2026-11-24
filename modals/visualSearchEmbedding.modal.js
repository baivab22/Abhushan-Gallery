const mongoose = require('mongoose')

/**
 * One document per indexed product image.
 * The vector is stored in MongoDB; similarity is computed in application code
 * over the small candidate set (no additional vector database required).
 */
const visualSearchEmbeddingSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    imageHash: {
      type: String,
      default: null,
      index: true,
    },
    embedding: {
      type: [Number],
      required: true,
    },
    embeddingModel: {
      type: String,
      required: true,
    },
    embeddingVersion: {
      type: String,
      required: true,
    },
    dimensions: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'missing', 'failed'],
      default: 'active',
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
)

visualSearchEmbeddingSchema.index({ productId: 1, imageUrl: 1 }, { unique: true })
visualSearchEmbeddingSchema.index({ embeddingModel: 1, embeddingVersion: 1, status: 1 })
visualSearchEmbeddingSchema.index({ productId: 1, status: 1 })

const VisualSearchEmbedding =
  mongoose.models.VisualSearchEmbedding ||
  mongoose.model('VisualSearchEmbedding', visualSearchEmbeddingSchema)

module.exports = VisualSearchEmbedding
