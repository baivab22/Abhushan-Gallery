const mongoose = require("mongoose");

const restockNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Email snapshot taken at subscribe time so the notification can still be
    // delivered even if the user record is later removed or renamed.
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    status: {
      type: String,
      // "failed" is terminal: the address kept bouncing/erroring. It is
      // excluded from the partial unique index, so the shopper can subscribe
      // again on the next stockout cycle.
      enum: ["pending", "sent", "cancelled", "failed"],
      default: "pending",
    },
    notifiedAt: {
      type: Date,
      default: null,
    },
    // Delivery bookkeeping. A pending record is "claimed" while an email is
    // being sent; if the process crashes mid-send the claim goes stale and the
    // worker can safely retry it after the lease expires.
    claimedAt: {
      type: Date,
      default: null,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    nextAttemptAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Only ONE pending subscription per (user, product). Sent/cancelled/failed
// records are excluded so a user can re-subscribe on the next stockout.
restockNotificationSchema.index(
  { userId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

// Fast lookup of everyone waiting for a specific product.
restockNotificationSchema.index({ productId: 1, status: 1 });

// Lets the retry worker find due pending records without scanning the whole
// collection. Old documents have no nextAttemptAt and are treated as due.
restockNotificationSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model(
  "RestockNotification",
  restockNotificationSchema
);
