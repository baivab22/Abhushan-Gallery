const mongoose = require('mongoose');

const {Product} = require('../modals/product.modal');
const FlashSale = require('../modals/flashSale.modal');

const DEFAULT_DURATION_HOURS = 24;
const DEFAULT_PUBLIC_LIMIT = 8;
const MAX_BULK_FLASH_PRODUCTS = 10000;
const SYNC_THROTTLE_MS = 10 * 1000;

class FlashSaleError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FlashSaleError';
    this.status = status;
  }
}

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const toNumber = (value) => {
  // `Number(null)` is 0, which would make "no previous price" indistinguishable
  // from a genuine free product. Treat empty values as missing everywhere.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const snapshotNumber = (value) =>
  value === null || value === undefined ? null : toNumber(value);

// The product's normal selling price before any campaign is applied.
const getBasePrice = (product) => {
  for (const candidate of [product?.discountedPrice, product?.originalPrice, product?.price]) {
    const n = toNumber(candidate);
    if (n !== null && n > 0) return n;
  }
  return 0;
};

// Authoritative unit price used by checkout. `discountedPrice` already carries
// the active sale price, but reading the flash metadata as well makes pricing
// correct even if the expiry sweep has not run yet (e.g. a stale tab).
const getEffectiveUnitPrice = (product, now = new Date()) => {
  if (!product) return 0;

  const flash = product.flashSale;
  if (flash && flash.campaignId && flash.salePrice !== null && flash.salePrice !== undefined) {
    const endsAt = flash.endsAt ? new Date(flash.endsAt).getTime() : null;
    const isStillRunning = endsAt === null || endsAt > now.getTime();

    if (isStillRunning) return roundMoney(flash.salePrice);

    // Sale window is over but the sweep has not restored the product yet.
    const previous = toNumber(flash.previousDiscountedPrice);
    if (previous !== null && previous > 0) return roundMoney(previous);
  }

  const discounted = toNumber(product.discountedPrice);
  if (discounted !== null && discounted > 0) return roundMoney(discounted);

  return roundMoney(getBasePrice(product));
};

const isValidObjectId = (value) =>
  value !== null && value !== undefined && mongoose.Types.ObjectId.isValid(String(value));

const clampPercentage = (value) => {
  const n = toNumber(value);
  if (n === null || n <= 0 || n > 100) return 0;
  return Math.round(n * 100) / 100;
};

// A category with its own configured percentage overrides the campaign default.
const getDiscountForProduct = (campaign, product) => {
  if (campaign?.scope === 'categories') {
    const categoryId = product?.category ? String(product.category) : '';
    const override = (campaign.categoryDiscounts || []).find(
      (entry) => String(entry.category) === categoryId
    );
    if (override) {
      const pct = clampPercentage(override.discountPercentage);
      if (pct > 0) return pct;
    }
  }
  return clampPercentage(campaign?.discountPercentage);
};

const normalizeCampaignPayload = (body = {}) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw new FlashSaleError(400, 'Campaign name is required.');

  const message = String(body.message ?? '').trim();

  const discountPercentage = clampPercentage(body.discountPercentage);
  if (!discountPercentage) {
    throw new FlashSaleError(400, 'Discount percentage must be greater than 0 and at most 100.');
  }

  let durationHours = toNumber(body.durationHours);
  if (durationHours === null) durationHours = DEFAULT_DURATION_HOURS;
  if (durationHours < 1 || durationHours > 720) {
    throw new FlashSaleError(400, 'Campaign duration must be between 1 and 720 hours.');
  }
  durationHours = Math.round(durationHours * 100) / 100;

  const startsAt = new Date(body.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw new FlashSaleError(400, 'A valid campaign start date/time is required.');
  }

  let endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (endsAt && Number.isNaN(endsAt.getTime())) {
    throw new FlashSaleError(400, 'Invalid campaign end date/time.');
  }
  if (!endsAt) {
    endsAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000);
  }
  if (endsAt <= startsAt) {
    throw new FlashSaleError(400, 'Campaign end time must be after its start time.');
  }

  const scope = body.scope === 'categories' ? 'categories' : 'all';

  const rawCategoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : [];
  const categoryIds = [];
  rawCategoryIds.forEach((id) => {
    if (isValidObjectId(id)) {
      const value = String(id);
      if (!categoryIds.includes(value)) categoryIds.push(value);
    }
  });

  const categoryDiscounts = [];
  if (Array.isArray(body.categoryDiscounts)) {
    body.categoryDiscounts.forEach((entry) => {
      if (!entry || !isValidObjectId(entry.category)) return;
      const pct = clampPercentage(entry.discountPercentage);
      if (!pct) return;
      const category = String(entry.category);
      const existing = categoryDiscounts.find((item) => item.category === category);
      if (existing) existing.discountPercentage = pct;
      else categoryDiscounts.push({category, discountPercentage: pct});
    });
  }

  if (scope === 'categories') {
    categoryDiscounts.forEach((entry) => {
      if (!categoryIds.includes(entry.category)) categoryIds.push(entry.category);
    });
    if (!categoryIds.length) {
      throw new FlashSaleError(400, 'Select at least one category for a category-wise flash sale.');
    }
  }

  return {
    name: name.slice(0, 120),
    message: message.slice(0, 300),
    discountPercentage,
    durationHours,
    startsAt,
    endsAt,
    scope,
    categoryIds,
    categoryDiscounts,
    allowCouponStacking: body.allowCouponStacking !== false,
  };
};

const buildEligibleProductQuery = (campaign) => {
  const query = {
    $and: [
      {
        $or: [
          {discountedPrice: {$gt: 0}},
          {originalPrice: {$gt: 0}},
          {price: {$gt: 0}},
        ],
      },
      // A product with an active sale (from any campaign) is never re-priced.
      // This is what prevents competing/stacked campaign discounts.
      {
        $or: [{flashSale: null}, {'flashSale.campaignId': null}],
      },
    ],
  };

  if (campaign.scope === 'categories') {
    const ids = Array.isArray(campaign.categoryIds)
      ? campaign.categoryIds.filter((id) => isValidObjectId(id)).map(String)
      : [];
    query.category = {$in: ids};
  }

  return query;
};

const applyCampaignToProducts = async (campaign, {session} = {}) => {
  const now = new Date();

  let productsQuery = Product.find(buildEligibleProductQuery(campaign))
    .select('name price originalPrice discountedPrice discountPercentage category flashSale')
    .limit(MAX_BULK_FLASH_PRODUCTS);
  if (session) productsQuery = productsQuery.session(session);
  const products = await productsQuery;

  const operations = [];

  products.forEach((product) => {
    const basePrice = getBasePrice(product);
    const discountPercentage = getDiscountForProduct(campaign, product);
    if (basePrice <= 0 || !discountPercentage) return;

    const salePrice = roundMoney(basePrice - (basePrice * discountPercentage) / 100);
    // Checkout requires a positive price, so a 100% campaign cannot be applied.
    if (salePrice <= 0 || salePrice >= basePrice) return;

    const originalPrice = toNumber(product.originalPrice);
    const originalForBadge = originalPrice !== null && originalPrice > 0
      ? originalPrice
      : basePrice;
    const combinedPercentage = Math.min(
      100,
      Math.max(0, roundMoney(((originalForBadge - salePrice) / originalForBadge) * 100))
    );

    operations.push({
      updateOne: {
        filter: {_id: product._id},
        update: {
          $set: {
            discountedPrice: salePrice,
            discountPercentage: combinedPercentage,
            flashSale: {
              campaignId: campaign._id,
              discountPercentage,
              salePrice,
              // Keep the original values as-is so restoration is exact, including
              // products that had no discounted price before the campaign.
              previousDiscountedPrice: snapshotNumber(product.discountedPrice),
              previousDiscountPercentage: snapshotNumber(product.discountPercentage),
              startsAt: campaign.startsAt,
              endsAt: campaign.endsAt,
              appliedAt: now,
            },
          },
        },
      },
    });
  });

  if (operations.length) {
    await Product.bulkWrite(operations, session ? {session} : {});
  }

  return {matchedCount: products.length, appliedCount: operations.length};
};

// Restore exactly the values that were snapshotted when the sale was applied.
// Products created/edited after the sale do not carry campaign metadata and
// are simply left alone.
const restoreCampaignProducts = async (campaign, {session} = {}) => {
  let productsQuery = Product.find({'flashSale.campaignId': campaign._id}).select(
    'price originalPrice discountedPrice flashSale'
  );
  if (session) productsQuery = productsQuery.session(session);
  const products = await productsQuery;

  const operations = [];

  products.forEach((product) => {
    const flash = product.flashSale || {};
    const previous = toNumber(flash.previousDiscountedPrice);
    const original = toNumber(product.originalPrice);
    const plainPrice = toNumber(product.price);
    const fallback = original !== null && original > 0
      ? original
      : (plainPrice !== null && plainPrice > 0 ? plainPrice : 0);

    // Snapshotted values win, even when the original discounted price was null
    // or zero. Only old/legacy snapshots without a value need a fallback.
    const hasSnapshot = flash.previousDiscountedPrice !== null &&
      flash.previousDiscountedPrice !== undefined;
    const restoredPrice = hasSnapshot
      ? previous
      : (fallback > 0 ? fallback : null);

    const update = {
      $set: {
        discountedPrice: restoredPrice,
        discountPercentage: snapshotNumber(flash.previousDiscountPercentage),
        flashSale: null,
      },
    };

    operations.push({updateOne: {filter: {_id: product._id}, update}});
  });

  if (operations.length) {
    await Product.bulkWrite(operations, session ? {session} : {});
  }

  return {matchedCount: products.length, restoredCount: operations.length};
};

let syncInFlight = null;
let lastSyncAt = 0;

// A due campaign must never wait for the throttle: expiry has to restore the
// original prices before any customer-facing read returns them.
const hasDueCampaigns = async (now = new Date()) =>
  Boolean(await FlashSale.exists({
    $or: [
      {status: {$in: ['active', 'scheduled']}, endsAt: {$lte: now}},
      {status: 'scheduled', startsAt: {$lte: now}, endsAt: {$gt: now}},
      {status: 'active', startsAt: {$gt: now}},
    ],
  }));

// Keeps campaign statuses and product prices aligned with the server clock.
// Safe to call from both the scheduler and public read endpoints.
const syncCampaignStatuses = async ({force = false} = {}) => {
  // Concurrent reads should wait for the same sync instead of returning stale
  // prices while another request is still restoring them.
  if (syncInFlight) return syncInFlight;

  const now = new Date();
  if (!force && Date.now() - lastSyncAt < SYNC_THROTTLE_MS) {
    let due = false;
    try {
      due = await hasDueCampaigns(now);
    } catch (error) {
      // If the due-check fails, run the sync anyway rather than risk serving
      // expired sale prices.
      due = true;
    }
    if (!due) return {skipped: true};
  }

  lastSyncAt = Date.now();
  syncInFlight = (async () => {
    const result = {expired: 0, started: 0, rescheduled: 0, restoredProducts: 0};

    const expiredCampaigns = await FlashSale.find({
      status: {$in: ['active', 'scheduled']},
      endsAt: {$lte: now},
    });
    for (const campaign of expiredCampaigns) {
      const restored = await restoreCampaignProducts(campaign);
      result.restoredProducts += restored.restoredCount;
      campaign.status = 'expired';
      campaign.lastRestoredAt = now;
      await campaign.save();
      result.expired += 1;
      console.log(`[FlashSale] Campaign "${campaign.name}" expired; prices restored.`);
    }

    // Scheduled campaign whose window has opened → start and apply.
    const startingCampaigns = await FlashSale.find({
      status: 'scheduled',
      startsAt: {$lte: now},
      endsAt: {$gt: now},
    });
    for (const campaign of startingCampaigns) {
      campaign.status = 'active';
      campaign.appliedAt = now;
      await campaign.save();
      const applied = await applyCampaignToProducts(campaign);
      campaign.appliedProductCount = applied.appliedCount;
      await campaign.save();
      result.started += 1;
      console.log(
        `[FlashSale] Campaign "${campaign.name}" started; ${applied.appliedCount} product(s) updated.`
      );
    }

    // An active campaign with a future start (e.g. edited after activation)
    // must not discount products before its window opens.
    const earlyCampaigns = await FlashSale.find({
      status: 'active',
      startsAt: {$gt: now},
    });
    for (const campaign of earlyCampaigns) {
      const restored = await restoreCampaignProducts(campaign);
      result.restoredProducts += restored.restoredCount;
      campaign.status = 'scheduled';
      campaign.lastRestoredAt = now;
      await campaign.save();
      result.rescheduled += 1;
    }

    return result;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
};

const assertNoConflictingCampaign = async (excludeId = null) => {
  const query = {status: {$in: ['active', 'scheduled']}};
  if (excludeId && isValidObjectId(excludeId)) query._id = {$ne: excludeId};
  const existing = await FlashSale.findOne(query).sort({createdAt: -1});
  if (existing) {
    throw new FlashSaleError(
      409,
      `A flash sale ("${existing.name}") is already active or scheduled. Deactivate or let it expire before creating another.`
    );
  }
};

const getActiveCampaign = async () => {
  const now = new Date();
  return FlashSale.findOne({
    status: 'active',
    startsAt: {$lte: now},
    endsAt: {$gt: now},
  }).sort({startsAt: -1});
};

const getCampaignProducts = async (campaign, {page = 1, limit = DEFAULT_PUBLIC_LIMIT} = {}) => {
  const pageNumber = Math.max(1, Number(page) || 1);
  const limitNumber = Math.min(48, Math.max(1, Number(limit) || DEFAULT_PUBLIC_LIMIT));
  const query = {'flashSale.campaignId': campaign._id};

  const total = await Product.countDocuments(query);
  const products = await Product.find(query)
    .populate('category')
    .populate('subCategory')
    .populate('nestedSubCategory')
    .sort({'flashSale.appliedAt': -1, name: 1})
    .skip((pageNumber - 1) * limitNumber)
    .limit(limitNumber);

  return {
    products,
    total,
    page: pageNumber,
    limit: limitNumber,
    totalPages: Math.max(1, Math.ceil(total / limitNumber)),
  };
};

const buildPublicPayload = (campaign, productsResult) => {
  const serverNow = new Date();
  const endsAt = new Date(campaign.endsAt);
  const startsAt = new Date(campaign.startsAt);
  const remainingSeconds = Math.max(0, Math.floor((endsAt.getTime() - serverNow.getTime()) / 1000));

  return {
    campaign: {
      id: String(campaign._id),
      name: campaign.name,
      message: campaign.message,
      discountPercentage: campaign.discountPercentage,
      durationHours: campaign.durationHours,
      scope: campaign.scope,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: campaign.status,
    },
    products: productsResult.products,
    serverNow: serverNow.toISOString(),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    remainingSeconds,
    pagination: {
      currentPage: productsResult.page,
      totalPages: productsResult.totalPages,
      totalProducts: productsResult.total,
      hasNextPage: productsResult.page < productsResult.totalPages,
      hasPrevPage: productsResult.page > 1,
      limit: productsResult.limit,
    },
  };
};

module.exports = {
  DEFAULT_DURATION_HOURS,
  DEFAULT_PUBLIC_LIMIT,
  MAX_BULK_FLASH_PRODUCTS,
  FlashSaleError,
  roundMoney,
  getBasePrice,
  getEffectiveUnitPrice,
  normalizeCampaignPayload,
  buildEligibleProductQuery,
  applyCampaignToProducts,
  restoreCampaignProducts,
  syncCampaignStatuses,
  // Lightweight entry point for read endpoints: only runs when a campaign is
  // actually due to start, expire or be rescheduled.
  syncDueFlashSales: () => syncCampaignStatuses({force: false}),
  assertNoConflictingCampaign,
  getActiveCampaign,
  getCampaignProducts,
  buildPublicPayload,
};
