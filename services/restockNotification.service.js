const mongoose = require("mongoose");
const RestockNotification = require("../modals/restockNotification.modal");
const { Product } = require("../modals/product.modal");
const User = require("../modals/userModal");
const { sendRestockAvailableEmail } = require("./emailServices");

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

// Safety cap per delivery pass. A second pass (worker) picks up any remainder,
// so a very popular product can never leave subscribers waiting forever.
const MAX_SUBSCRIBERS_PER_EVENT = toPositiveInt(
  process.env.RESTOCK_MAX_SUBSCRIBERS_PER_EVENT,
  500
);

// A pending record claimed by a crashed process is retried after this lease.
const CLAIM_LEASE_MS = toPositiveInt(
  process.env.RESTOCK_JOB_LOCK_TTL_MS,
  10 * 60 * 1000
);

const MAX_ATTEMPTS = toPositiveInt(process.env.RESTOCK_MAX_ATTEMPTS, 5);
const RETRY_BASE_MS = toPositiveInt(
  process.env.RESTOCK_RETRY_BASE_MS,
  30 * 1000
);
const RETRY_MAX_MS = toPositiveInt(
  process.env.RESTOCK_RETRY_MAX_MS,
  60 * 60 * 1000
);
const WORKER_BATCH = toPositiveInt(process.env.RESTOCK_WORKER_BATCH, 50);

// The restock cycle starts when a product leaves "out of stock" (<= 0) and
// becomes sellable again. By default ANY positive quantity is enough (0 -> 1
// must notify). Set RESTOCK_NOTIFY_MIN_STOCK=2 if the store wants to wait for
// more than one unit before emailing.
const MIN_STOCK_FOR_RESTOCK = toPositiveInt(
  process.env.RESTOCK_NOTIFY_MIN_STOCK,
  1
);

const isValidId = (value) =>
  Boolean(value) && mongoose.isValidObjectId(String(value));

/**
 * True when a stock change crosses out of "not sellable" into "sellable".
 * A missing/corrupt previous value is treated as out of stock rather than
 * silently skipping the alert.
 */
const didRestock = (previousStockQuantity, nextStockQuantity) => {
  const next = Number(nextStockQuantity);
  if (!Number.isFinite(next) || next < MIN_STOCK_FOR_RESTOCK) return false;

  const previous = Number(previousStockQuantity);
  return !Number.isFinite(previous) || previous <= 0;
};

const getRetryDelayMs = (attempts) => {
  const exponent = Math.max(0, Number(attempts) - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
};

/**
 * Register a user for a one-time restock notification of a product.
 * Idempotent: subscribing twice within the same stockout cycle is a no-op.
 *
 * @returns {{ subscribed: boolean, alreadySubscribed: boolean, reason?: string }}
 */
const subscribeUserToRestock = async ({ userId, productId }) => {
  if (!isValidId(userId) || !isValidId(productId)) {
    return {
      subscribed: false,
      alreadySubscribed: false,
      reason: "INVALID_REQUEST",
    };
  }

  const [user, product] = await Promise.all([
    User.findById(userId).select("email status"),
    Product.findById(productId).select("_id"),
  ]);

  if (!user) {
    return {
      subscribed: false,
      alreadySubscribed: false,
      reason: "USER_NOT_FOUND",
    };
  }
  // Older accounts may predate the status field entirely. Treat a missing
  // status as active instead of silently refusing to save their alert.
  if (user.status && user.status !== "active") {
    return {
      subscribed: false,
      alreadySubscribed: false,
      reason: "USER_INACTIVE",
    };
  }
  if (!user.email) {
    return {
      subscribed: false,
      alreadySubscribed: false,
      reason: "EMAIL_MISSING",
    };
  }
  if (!product) {
    return {
      subscribed: false,
      alreadySubscribed: false,
      reason: "PRODUCT_NOT_FOUND",
    };
  }

  const filter = {
    userId: user._id,
    productId: product._id,
    status: "pending", // an old sent/failed record must never block a new cycle
  };

  const existing = await RestockNotification.findOne(filter).lean();
  if (existing) {
    return { subscribed: true, alreadySubscribed: true };
  }

  try {
    await RestockNotification.create({
      userId: user._id,
      productId: product._id,
      email: String(user.email).toLowerCase().trim(),
    });
    return { subscribed: true, alreadySubscribed: false };
  } catch (error) {
    // Concurrent subscribe hit the partial unique index → someone else just
    // created the same pending record; that is still a successful opt-in.
    if (error?.code === 11000) {
      return { subscribed: true, alreadySubscribed: true };
    }
    throw error;
  }
};

/**
 * Cancel a pending subscription (e.g. user changed their mind).
 */
const cancelRestockSubscription = async ({ userId, productId }) => {
  if (!isValidId(userId) || !isValidId(productId)) return false;

  const result = await RestockNotification.updateOne(
    { userId, productId, status: "pending" },
    {
      $set: { status: "cancelled", nextAttemptAt: null, lastError: null },
      $unset: { claimedAt: "" },
    }
  );
  return result.modifiedCount > 0;
};

const buildDueClaimFilter = (now, leaseCutoff) => ({
  $and: [
    // nextAttemptAt is absent on records created by older versions; those are
    // immediately eligible.
    { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
    // A live claim belongs to another worker. An expired claim is recoverable.
    { $or: [{ claimedAt: null }, { claimedAt: { $lte: leaseCutoff } }] },
  ],
});

/**
 * Notify every pending subscriber that a product is back in stock.
 *
 * Claim-then-send keeps each subscriber to AT MOST ONE email per restock, even
 * if the admin update, the worker, and another server instance run at the same
 * time. A failed send is released with exponential backoff so the worker can
 * retry it; after RESTOCK_MAX_ATTEMPTS it is marked failed instead of retrying
 * forever.
 *
 * @returns {{ skipped?: string, notified: number, failed: number }} summary
 */
const notifySubscribersOfRestock = async (productId) => {
  if (!isValidId(productId)) {
    return { skipped: "INVALID_PRODUCT", notified: 0, failed: 0 };
  }

  // Re-read live stock — never announce availability we cannot back up.
  const product = await Product.findById(productId)
    .select(
      "name price discountedPrice originalPrice images stockQuantity"
    )
    .lean();

  if (!product) {
    return { skipped: "PRODUCT_NOT_FOUND", notified: 0, failed: 0 };
  }

  const currentStock = Number(product.stockQuantity ?? 0);
  if (!Number.isFinite(currentStock) || currentStock < MIN_STOCK_FOR_RESTOCK) {
    return { skipped: "OUT_OF_STOCK", notified: 0, failed: 0 };
  }

  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - CLAIM_LEASE_MS);

  const pending = await RestockNotification.find({
    productId,
    status: "pending",
    ...buildDueClaimFilter(now, leaseCutoff),
  })
    .select("_id")
    .sort({ createdAt: 1 })
    .limit(MAX_SUBSCRIBERS_PER_EVENT)
    .lean();

  let notified = 0;
  let failed = 0;

  for (const { _id } of pending) {
    // Atomic claim: only ONE caller can own a pending document at a time.
    // Use a fresh timestamp per record: a large batch can take several minutes
    // to send, and an old fixed timestamp would look like an expired lease to
    // another worker before this one has finished.
    const claimNow = new Date();
    const claimLeaseCutoff = new Date(claimNow.getTime() - CLAIM_LEASE_MS);
    const claimed = await RestockNotification.findOneAndUpdate(
      {
        _id,
        status: "pending",
        ...buildDueClaimFilter(claimNow, claimLeaseCutoff),
      },
      { $set: { claimedAt: claimNow, lastAttemptAt: claimNow } },
      { new: true }
    );
    if (!claimed) continue;

    const attempts = Number(claimed.attempts || 0) + 1;

    try {
      await sendRestockAvailableEmail(claimed.email, product);

      // Only now is it safe to call this notification "sent". If the process
      // dies before this update, the stale claim is retried after the lease.
      await RestockNotification.updateOne(
        { _id, status: "pending", claimedAt: claimNow },
        {
          $set: {
            status: "sent",
            notifiedAt: new Date(),
            lastAttemptAt: new Date(),
            nextAttemptAt: null,
            lastError: null,
          },
          $unset: { claimedAt: "" },
          $inc: { attempts: 1 },
        }
      );
      notified += 1;
    } catch (error) {
      failed += 1;
      const message = String(error?.message || error).slice(0, 500);
      const terminal = attempts >= MAX_ATTEMPTS;
      const nextAttemptAt = terminal
        ? null
        : new Date(Date.now() + getRetryDelayMs(attempts));

      console.error(
        `[Restock] Failed to notify ${claimed.email} for product ${productId} ` +
          `(attempt ${attempts}/${MAX_ATTEMPTS})${terminal ? " — giving up" : ""}:`,
        message
      );

      // Release the claim so the worker can retry this subscriber later.
      await RestockNotification.updateOne(
        { _id, status: "pending", claimedAt: claimNow },
        {
          $set: {
            status: terminal ? "failed" : "pending",
            lastAttemptAt: new Date(),
            nextAttemptAt,
            lastError: message,
          },
          $unset: { claimedAt: "" },
          $inc: { attempts: 1 },
        }
      ).catch((updateError) => {
        console.error(
          `[Restock] Could not release failed notification ${_id}:`,
          updateError?.message || updateError
        );
      });
    }
  }

  if (pending.length > 0 || notified > 0 || failed > 0) {
    console.log(
      `[Restock] Product ${productId}: ${notified} subscriber(s) notified, ${failed} failed.`
    );
  }
  return { notified, failed };
};

/**
 * Worker entry point: find pending records that are due, keep only products
 * that are actually in stock, and deliver their emails. This is the safety net
 * for a missed trigger, a crashed process, or a temporary SMTP failure.
 */
const processDueRestockNotifications = async ({
  limit = WORKER_BATCH,
} = {}) => {
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - CLAIM_LEASE_MS);

  const dueProducts = await RestockNotification.aggregate([
    {
      $match: {
        status: "pending",
        ...buildDueClaimFilter(now, leaseCutoff),
      },
    },
    { $group: { _id: "$productId" } },
    { $limit: toPositiveInt(limit, WORKER_BATCH) },
  ]);

  const productIds = dueProducts.map((entry) => entry._id).filter(Boolean);
  if (productIds.length === 0) {
    return { products: 0, notified: 0, failed: 0 };
  }

  const inStockProducts = await Product.find({
    _id: { $in: productIds },
    stockQuantity: { $gte: MIN_STOCK_FOR_RESTOCK },
  })
    .select("_id")
    .lean();

  let notified = 0;
  let failed = 0;

  for (const product of inStockProducts) {
    try {
      const result = await notifySubscribersOfRestock(product._id);
      notified += result.notified;
      failed += result.failed;
    } catch (error) {
      // One bad product must not block the rest of the sweep. The record stays
      // pending, so the next sweep retries it.
      console.error(
        `[Restock][worker] Product ${product._id} failed:`,
        error?.message || error
      );
    }
  }

  if (notified > 0 || failed > 0) {
    console.log(
      `[Restock][worker] Processed ${inStockProducts.length} product(s): ` +
        `${notified} notified, ${failed} failed.`
    );
  }

  return { products: inStockProducts.length, notified, failed };
};

module.exports = {
  subscribeUserToRestock,
  cancelRestockSubscription,
  notifySubscribersOfRestock,
  processDueRestockNotifications,
  didRestock,
};
