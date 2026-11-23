const mongoose = require('mongoose');

// A flash sale is a time-boxed, product-level promotion. It never rewrites a
// product's `price` / `originalPrice`; instead the active sale price is written
// into `discountedPrice` (the field the whole store already treats as the
// selling price) and the pre-sale values are snapshotted on each product so
// they can be restored when the campaign ends.
//
// Only one campaign may be effective at a time. Historical (paused/expired)
// campaigns are kept for the admin list and audit trail.

const FLASH_SALE_STATUSES = ['scheduled', 'active', 'paused', 'expired'];

const categoryDiscountSchema = new mongoose.Schema(
  {
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    discountPercentage: {
      type: Number,
      required: true,
      min: 0.01,
      max: 100,
    },
  },
  { _id: false }
);

const flashSaleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: FLASH_SALE_STATUSES,
      default: 'scheduled',
      index: true,
    },
    // Percentage taken off the product's current selling price.
    discountPercentage: {
      type: Number,
      required: true,
      min: 0.01,
      max: 100,
    },
    // Used to derive endsAt when the admin only supplies a start time.
    durationHours: {
      type: Number,
      default: 24,
      min: 1,
      max: 720,
    },
    startsAt: {
      type: Date,
      required: true,
      index: true,
    },
    endsAt: {
      type: Date,
      required: true,
      index: true,
    },
    scope: {
      type: String,
      enum: ['all', 'categories'],
      default: 'all',
    },
    // Category-wise scope. `categoryDiscounts` allows a different percentage
    // per category; `categoryIds` is kept so a selected category with no
    // explicit override still receives the campaign default.
    categoryIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Category',
      default: [],
    },
    categoryDiscounts: {
      type: [categoryDiscountSchema],
      default: [],
    },
    // Existing coupon codes are order-level discounts. Keep them working by
    // default; an admin can turn this off to forbid stacking at checkout.
    allowCouponStacking: {
      type: Boolean,
      default: true,
    },
    appliedProductCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    appliedAt: {
      type: Date,
      default: null,
    },
    lastRestoredAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

flashSaleSchema.pre('validate', function (next) {
  if (this.startsAt && this.endsAt && new Date(this.endsAt) <= new Date(this.startsAt)) {
    return next(new Error('Campaign end time must be after its start time.'));
  }
  next();
});

flashSaleSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
  },
});

const FlashSale = mongoose.model('FlashSale', flashSaleSchema);

module.exports = FlashSale;
module.exports.FLASH_SALE_STATUSES = FLASH_SALE_STATUSES;
