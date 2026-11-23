const mongoose = require("mongoose");

const productImageSchema = new mongoose.Schema(
  {
    colorName: String,
    coloredImages: {
      type: [String],
      required: true,
      default: undefined,
    },
  },
  {
    timestamps: true, // ✅ Adds createdAt and updatedAt
  }
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
    },
    
    description: {
      type: String,
    },
    
    price: {
      type: Number,
    },
    
    stockQuantity: {
      type: Number,
      required: true,
    },
    
    isBestSelling: {
      type: Boolean,
      required: false,
    },
    
    isNewArrivals: {
      type: Boolean,
      required: false,
    },
    
    video: {
      type: String,
      required: false,
    },
    
    isWatchAndShop: {
      type: Boolean,
      required: false,
    },

    showInHomePage: {
      type: Boolean,
      required: false,
      default: false,
    },
    
    isHotSelling: { 
      type: Boolean, 
      required: true, 
      default: false 
    },
    
    originalPrice: {
      type: Number,
    },
    
    discountedPrice: {
      type: Number,
    },
    
    discountPercentage: {
      type: Number,
    },
    
    images: [{
      colorName: String,
      coloredImages: {
        type: [String],
        required: true,
        default: undefined,
      }
    }],
    
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },
    
    subCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubCategory",
    },
    
    nestedSubCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubCategoryNested",
      required: false,
    },

    totalSales: {
      type: Number,
      default: 0
    },
    
    lastSoldAt: {
      type: Date
    },
    
    // Track if out-of-stock notification has been sent
    outOfStockNotificationSent: {
      type: Boolean,
      default: false
    },

    // Active flash-sale metadata. `discountedPrice` temporarily holds the sale
    // price while the previous values are kept here for restoration on expiry.
    flashSale: {
      campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "FlashSale",
        default: null,
      },
      discountPercentage: {
        type: Number,
        default: null,
      },
      salePrice: {
        type: Number,
        default: null,
      },
      previousDiscountedPrice: {
        type: Number,
        default: null,
      },
      previousDiscountPercentage: {
        type: Number,
        default: null,
      },
      startsAt: {
        type: Date,
        default: null,
      },
      endsAt: {
        type: Date,
        default: null,
      },
      appliedAt: {
        type: Date,
        default: null,
      },
    }
  },
  {
    timestamps: true, // ✅ Adds createdAt and updatedAt
  }
);

productSchema.set("toJSON", {
  transform: function (doc, ret) {
    ret.id = ret._id;
    delete ret._id;
  },
});

const Product = mongoose.model("Product", productSchema);
const ProductImage = mongoose.model("ProductImage", productImageSchema);

module.exports = {
  Product,
  ProductImage,
};