const mongoose = require("mongoose");

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
];

const OrderStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ORDER_STATUSES,
      required: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    updatedBy: {
      type: String,
      enum: ["admin", "system", "user"],
      default: "admin",
    },
  },
  { _id: false }
);

const OrderProductSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,   // allows guest orders with no account
  },

  // Guest checkout fields (only populated when userId is absent)
  email: { type: String, required: false },
  fullName: { type: String, required: false },
  isGuestCheckout: { type: Boolean, default: false },

  // Customer name entered in the cart checkout form ("Shipping Details").
  // Captured for every order — logged in or guest — and surfaced in the admin
  // dashboard, the printed invoice and the confirmation emails.
  name: { type: String, required: false, trim: true },

  products: [
    {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
      quantity: Number,
      price: Number,
      colorName: String,
    },
  ],

giftBoxCharge:Number,
  isRedZone:Boolean,
  includeGiftBox:Boolean,
  deliveryTimeMessage:String,
  deliveryPartnerPrice:Number,
  orderedBefore12PM:Boolean,
  

  OrderedAt: String,

  // Updated shipping location to handle coordinates and address

    latitude: {
      type: Number,
      required: false,
    },
    longitude: {
      type: Number,
      required: false,
    },
    locationAddress: {
      type: String,
      required: false,
    },

      isInsideValley: Boolean,
  

  // Public order reference. New orders receive a server-generated 5-digit
  // numeric string (e.g. "00017") so leading zeros are preserved. The unique
  // index is the authority that prevents two orders sharing an ID; creation
  // retries on duplicate-key errors. Legacy orders keep their original IDs.
  productOrderId: {
    type: String,
    trim: true,
    unique: true,
    index: true,
  },
  date: {
    type: Date,
    default: Date.now, // Automatically sets current date/time when a document is created
  },
  shippingPrice: Number,
  totalAmount: Number,
  couponCode: String,
  couponDiscount: { type: Number, default: 0 },
  phoneNumber: String,
  isHomeDelivery:Boolean,
  shippingLocation: {
    type: String,
    required: true,
    trim: true,
  },
  paymentMethod:String,

  paymentScreenshot: {
    type: String,
    default: null,
  },
  paymentScreenshotUploadedAt: {
    type: Date,
    default: null,
  },
  paymentChannel: String,

  // How much of the order the customer settled up front. Only meaningful for
  // outside-valley Phone Pay orders: 'partial' = shipping charge now, balance
  // on delivery; 'full' = complete amount paid. Absent for every other flow.
  paymentMode: {
    type: String,
    enum: ["partial", "full"],
    required: false,
  },

  orderNote:String,

    isScanned: {
    type: Boolean,
    default: false
  },
  scannedAt: {
    type: Date
  },

    isConfirmed: {
      type: Boolean,
      default: false,
    },
    confirmedAt: {
      type: Date,
    },

    deliveryPartner: String,

  status: {
    type: String,
    enum: ORDER_STATUSES,
    default: "pending",
    index: true,
  },
  statusHistory: {
    type: [OrderStatusHistorySchema],
    default: () => [{ status: "pending" }],
  },
 
  // timestamps: true
});



module.exports = mongoose.model("Orders", OrderProductSchema);
