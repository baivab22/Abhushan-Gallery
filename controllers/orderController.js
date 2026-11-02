const mongoose = require('mongoose');
const Orders = require("../modals/orderModal");
const User = require("../modals/userModal");
const { Product } = require("../modals/product.modal");
const Coupon = require("../modals/coupon.modal");
const {
  getPaymentScreenshotFile,
  getPaymentScreenshotPath,
  removeUploadedScreenshot,
} = require("../handlers/multerPaymentScreenshot.handler");
const {
  validateCouponForOrder,
  normalizeCouponCode,
} = require("./couponController");
const {
  sendOutOfStockNotification,
  sendCompleteOutOfStockReport,
  sendNewOrderPlacedNotification,
  sendOrderConfirmationToCustomer,
} = require("../services/emailServices");
const {
  notifySubscribersOfRestock,
} = require("../services/restockNotification.service");
const {
  sendOrderDeliveryStatusChangedNotification,
} = require("../services/orderNotificationService");
const {
  createWithUniqueOrderId,
  generateAvailableOrderId,
  isDuplicateOrderIdError,
  normalizeOrderId,
} = require("../utils/orderId.util");

const isTruthy = (value) => value === true || value === 'true' || value === 1 || value === '1';

class OrderRequestError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'OrderRequestError';
    this.status = status;
    this.extra = extra;
  }
}

const PHONE_PAY = 'phonePay';
const CASH_ON_DELIVERY = 'cashOnDelivery';
const ORDER_PAYLOAD_FIELD = 'orderData';

// Runs after the HTTP response has already been sent.
//
// A single Gmail sendMail costs ~4s on this project's SMTP host, and order
// placement fires up to three of them (admin notice, customer confirmation,
// out-of-stock alert). Awaiting them inline made the customer stare at a
// disabled "Place Order" button for 8-13s even though the order itself was
// committed in well under a second.
//
// setImmediate defers past the current tick so the response flushes first, and
// the trailing catch keeps a rejected notification from becoming an unhandled
// rejection that would take the process down.
const runAfterResponse = (task) => {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error('[order] background notification failed:', error?.message || error);
      });
  });
};

// Bulk confirmation used to await every order inside a for-loop, so N orders
// cost N x (DB work + email). Now only the DB work is awaited, and it is
// bounded-parallel. The cap keeps Mongo and the SMTP connection from being
// hammered when an admin confirms a large batch at once.
const CONFIRM_BULK_CONCURRENCY = 5;
const ORDER_STATUSES = new Set([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);

const ORDER_STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Processing',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const normalizeOrderStatus = (value) => {
  const status = String(value || '').trim().toLowerCase();
  return ORDER_STATUSES.has(status) ? status : null;
};

const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;

  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  };

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runner));

  return results;
};

// New orders get a server-generated 5-digit order reference. The client may
// send a valid 5-digit `productOrderId` obtained from the generate-id endpoint
// (so the payment remarks match the order), but the database unique index and
// the retry loop below remain the authority for uniqueness. Legacy clients that
// send an old-style long ID simply get a new 5-digit ID from the server.

// Multipart form-data cannot carry the nested order payload, so the client sends
// it as a single JSON field. Plain JSON clients keep working unchanged.
const parseOrderPayload = (body) => {
  const rawPayload = body?.[ORDER_PAYLOAD_FIELD];

  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    return body;
  }

  try {
    const parsed = JSON.parse(rawPayload);
    return parsed && typeof parsed === 'object' ? parsed : body;
  } catch {
    const error = new Error('Order payload is not valid JSON.');
    error.status = 400;
    throw error;
  }
};

const normalizeOrderPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('977') && digits.length >= 13) {
    return digits.slice(-10);
  }
  if (digits.length > 10) {
    return digits.slice(-10);
  }
  return digits;
};

const isValidOrderPhone = (phone) => {
  const safe = String(phone || '');
  return /^9\d{9}$/.test(safe) || /^\d{7,10}$/.test(safe);
};

const orderPopulateConfig = [
  { path: 'userId' },
  {
    path: 'products.productId',
    model: 'Product',
    populate: {
      path: 'images',
      model: 'ProductImage',
    },
  },
];

const populateOrderDoc = (query) => {
  let chain = query;
  orderPopulateConfig.forEach((cfg) => {
    chain = chain.populate(cfg);
  });
  return chain;
};

const findOrderByIdentifier = async (identifier) => {
  const safe = String(identifier || '').trim();
  if (!safe) return null;
  if (mongoose.Types.ObjectId.isValid(safe)) {
    const byId = await Orders.findById(safe);
    if (byId) return byId;
  }
  return Orders.findOne({ productOrderId: safe });
};

const confirmOrderAndSync = async (orderIdentifier, bodyData) => {
  const existing = await findOrderByIdentifier(orderIdentifier);
  if (!existing) {
    return {
      found: false,
      updatedOrder: null,
      isConfirmingNow: false,
    };
  }

  const hasExplicitStatus = bodyData?.status !== undefined;
  const confirmRequested =
    isTruthy(bodyData?.isConfirmed) &&
    (!hasExplicitStatus || bodyData.status === 'confirmed');
  const isConfirmingNow = confirmRequested && existing.isConfirmed !== true;

  const patchData = { ...bodyData };

  if (isConfirmingNow && !patchData.confirmedAt) {
    patchData.confirmedAt = new Date();
  }
  if (confirmRequested) {
    patchData.status = 'confirmed';
  }

  const updatedOrderDoc = await Orders.findById(existing._id);
  Object.assign(updatedOrderDoc, patchData);
  if (patchData.status && patchData.status !== existing.status) {
    updatedOrderDoc.statusHistory = [
      ...(updatedOrderDoc.statusHistory || []),
      { status: patchData.status, updatedAt: new Date() },
    ];
  }
  // Save the document before populating it. `save()` returns a Promise, while
  // `populateOrderDoc` expects a Mongoose query and cannot populate that
  // Promise directly.
  const savedOrder = await updatedOrderDoc.save();
  const updatedOrder = await Orders.populate(savedOrder, orderPopulateConfig);
  const statusChanged =
    patchData.status &&
    patchData.status !== existing.status;

  if (isConfirmingNow && updatedOrder) {
    // Deliberately off the request path, for the same reason as createOrder.
    // This email renders a PDF invoice through Puppeteer and then hands it to
    // Gmail: ~4.1s of SMTP plus ~1.5-3s of headless-Chrome work. Awaiting it
    // here held the admin's spinner and the HTTP socket open for ~9s per
    // confirmation. The order is already committed and populated above, so a
    // slow or failed email can no longer roll back or fail the confirmation.
    const orderForEmail = updatedOrder;
    runAfterResponse(async () => {
      const customerConfirmationSent = await sendOrderConfirmationToCustomer(orderForEmail);
      if (!customerConfirmationSent) {
        console.error('Customer order confirmation email was not sent for order', orderForEmail?._id);
      }
    });
  } else if (statusChanged && updatedOrder) {
    const orderForEmail = updatedOrder;
    runAfterResponse(async () => {
      const notification = await sendOrderDeliveryStatusChangedNotification(orderForEmail, {
        previousStatus: ORDER_STATUS_LABELS[existing.status] || 'Pending',
        newStatus: orderForEmail.status,
        newStatusLabel: ORDER_STATUS_LABELS[orderForEmail.status] || orderForEmail.status,
        statusTime: orderForEmail.statusHistory?.length
          ? orderForEmail.statusHistory[orderForEmail.statusHistory.length - 1].updatedAt
          : undefined,
      });
      if (!notification?.sent && !notification?.skipped) {
        console.error(
          '[order] status update email was not sent for order',
          orderForEmail?._id,
          notification?.reason || 'Unknown error'
        );
      }
    });
  }

  return {
    found: true,
    updatedOrder,
    isConfirmingNow,
    statusChanged: Boolean(statusChanged),
  };
};

// Post-commit side effects for a newly created order. Deliberately kept out of
// the request path — see runAfterResponse. Nothing here may reject: a failed
// email must never turn a placed order into a failed request.
//
// Admin-only by design. The customer already sees the result in-app (toast +
// WhatsApp hand-off with the payment screenshot), so the "Order Received"
// confirmation mail on place-order is redundant noise for them. The customer
// still gets an email later, from the confirm flow via
// sendOrderConfirmationToCustomer (orderController.confirmOrderAndSync and
// scanController.markOrderAsScanned) — that one is untouched.
const dispatchOrderNotifications = async (orderId, outOfStockProducts) => {
  if (outOfStockProducts.length > 0) {
    try {
      await sendOutOfStockNotification(outOfStockProducts);

      // Mark that notification has been sent for these products
      for (const product of outOfStockProducts) {
        await Product.findByIdAndUpdate(product._id, { outOfStockNotificationSent: true });
      }
    } catch (emailError) {
      console.error('Failed to send out-of-stock notifications:', emailError);
    }
  }

  const enrichedOrder = await Orders.findById(orderId)
    .populate('userId')
    .populate('products.productId');

  if (!enrichedOrder) {
    console.error('[order] could not reload order for notification:', orderId);
    return;
  }

  try {
    const sent = await sendNewOrderPlacedNotification(enrichedOrder);
    if (!sent) {
      console.error('Admin new-order email was NOT sent for order', enrichedOrder?.productOrderId);
    } else {
      console.log('Admin notification email sent successfully for order:', enrichedOrder.productOrderId);
    }
  } catch (adminEmailError) {
    console.error('Failed to send admin order notification email:', adminEmailError?.message || adminEmailError);
  }
};

exports.createOrder = async (req, res) => {
  const screenshotFile = getPaymentScreenshotFile(req);
  const paymentScreenshot = getPaymentScreenshotPath(screenshotFile);

  let orderBody;
  try {
    orderBody = parseOrderPayload(req.body) || {};
  } catch (error) {
    await removeUploadedScreenshot(screenshotFile);
    return res.status(400).json({ error: error.message });
  }

  const requestedOrderId = normalizeOrderId(orderBody.productOrderId);
  const normalizedLocationAddress = String(orderBody?.locationAddress || '').trim();
  const normalizedShippingLocation = String(orderBody?.shippingLocation || '').trim();
  const normalizedPhoneNumber = normalizeOrderPhone(orderBody?.phoneNumber);
  const isPhonePayOrder = orderBody.paymentMethod === PHONE_PAY;

  // The customer name is entered in the cart checkout form and sent as
  // orderBody.name. Older clients may not send it yet, so fall back to the
  // account name — a stale tab must never fail an otherwise valid order.
  let normalizedName = String(orderBody?.name || orderBody?.fullName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  if (!normalizedName && orderBody?.userId && mongoose.Types.ObjectId.isValid(String(orderBody.userId))) {
    try {
      const accountUser = await User.findById(orderBody.userId).select('name').lean();
      normalizedName = String(accountUser?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    } catch (nameLookupError) {
      console.error('Could not resolve account name for order:', nameLookupError?.message || nameLookupError);
    }
  }

  const rejectOrder = async (status, message, extra = {}) => {
    await removeUploadedScreenshot(screenshotFile);
    return res.status(status).json({ error: message, ...extra });
  };

  if (!normalizedShippingLocation) {
    return rejectOrder(400, 'Exact location is required.');
  }

  if (!isValidOrderPhone(normalizedPhoneNumber)) {
    return rejectOrder(
      400,
      'Invalid phone number. Please provide a valid phone number before placing order.'
    );
  }

  const orderProducts = Array.isArray(orderBody.products) ? orderBody.products : [];

  if (orderProducts.length === 0) {
    return rejectOrder(400, 'At least one product is required to place an order.');
  }

  if (isPhonePayOrder && !paymentScreenshot) {
    return rejectOrder(
      400,
      'Payment screenshot is required for Phone Pay orders. Please upload the payment screenshot before placing the order.'
    );
  }

  // Cash on Delivery is an inside-the-valley-only option. The checkout UI
  // hides it for "Outside Kathmandu Valley", but the API enforces the same
  // rule so a stale tab (or a hand-crafted request) can't slip it through.
  // The client sends isInsideValley as JSON.stringify(...), so it may arrive
  // as the string "true"/"false" rather than a boolean.
  const isInsideValleyOrder = isTruthy(orderBody.isInsideValley);
  if (orderBody.paymentMethod === CASH_ON_DELIVERY && !isInsideValleyOrder) {
    return rejectOrder(
      400,
      'Cash on Delivery is not available for deliveries outside Kathmandu Valley. Please choose Phone Pay.'
    );
  }

  // Outside-the-valley Phone Pay orders can be settled partially (shipping
  // charge now, balance on delivery) or in full. No other flow may carry the
  // flag, so a stale tab cannot mislabel an order.
  const normalizedPaymentMode = String(orderBody.paymentMode || '').trim().toLowerCase();
  if (normalizedPaymentMode && normalizedPaymentMode !== 'partial' && normalizedPaymentMode !== 'full') {
    return rejectOrder(400, 'Invalid payment mode. It must be "partial" or "full".');
  }
  if (normalizedPaymentMode === 'partial' && !(isPhonePayOrder && !isInsideValleyOrder)) {
    return rejectOrder(
      400,
      'Partial payment is only available for Phone Pay orders delivered outside Kathmandu Valley.'
    );
  }

  // Each attempt is a complete transaction. If MongoDB rejects the order ID as
  // a duplicate, the transaction is rolled back (stock and coupon included) and
  // createWithUniqueOrderId retries with a fresh 5-digit candidate.
  const createOrderAttempt = async (orderIdForAttempt) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    const attemptOutOfStockProducts = [];

    try {
      // Coupon validation — always enforced server-side against the line-item subtotal
      let appliedCoupon = null;
      let couponDiscount = 0;
      const rawCouponCode = normalizeCouponCode(orderBody.couponCode);
      if (rawCouponCode) {
        // NOTE: products[].price is the LINE TOTAL (unit price × quantity) sent by the client
        const couponSubtotal = orderProducts
          .reduce((sum, item) => sum + (Number(item?.price) || 0), 0);
        const couponResult = await validateCouponForOrder(rawCouponCode, couponSubtotal, orderBody.userId);
        if (!couponResult.ok) {
          throw new OrderRequestError(400, `Coupon rejected: ${couponResult.message}`);
        }
        appliedCoupon = couponResult.coupon;
        couponDiscount = couponResult.discountAmount;
      }

      // Atomic stock decrement — prevents race conditions
      for (const product of orderProducts) {
        const { productId, quantity } = product;

        const result = await Product.findOneAndUpdate(
          { _id: productId, stockQuantity: { $gte: quantity } },
          {
            $inc: { stockQuantity: -quantity, totalSales: quantity },
            $set: { lastSoldAt: new Date() },
          },
          { session, new: true }
        );

        if (!result) {
          throw new OrderRequestError(400, `Not enough stock for product ${productId}`);
        }

        // Check if product became out of stock
        if (result.stockQuantity === 0) {
          attemptOutOfStockProducts.push({
            ...result.toObject(),
            previousStock: result.stockQuantity + quantity,
            orderedQuantity: quantity,
          });
        }
      }

      const newOrderData = new Orders({
        userId: orderBody.userId,
        email: orderBody.email,
        fullName: orderBody.fullName,
        name: normalizedName || undefined,
        isGuestCheckout: orderBody.isGuestCheckout,
        products: orderProducts,
        giftBoxCharge: orderBody.giftBoxCharge,
        isRedZone: orderBody.isRedZone,
        includeGiftBox: orderBody.includeGiftBox,
        deliveryTimeMessage: orderBody.deliveryTimeMessage,
        deliveryPartnerPrice: orderBody.deliveryPartnerPrice,
        orderedBefore12PM: orderBody.orderedBefore12PM,
        OrderedAt: orderBody.OrderedAt,
        latitude: orderBody.latitude,
        longitude: orderBody.longitude,
        locationAddress: normalizedLocationAddress,
        isInsideValley: orderBody.isInsideValley,
        productOrderId: orderIdForAttempt,
        shippingPrice: orderBody.shippingPrice,
        // Recomputed server-side — never trust the client-sent totalAmount.
        // products[].price is the LINE TOTAL (unit price × quantity) sent by the client.
        totalAmount:
          orderProducts.reduce((sum, item) => sum + (Number(item?.price) || 0), 0) +
          (Number(orderBody.shippingPrice) || 0) +
          (Number(orderBody.giftBoxCharge) || 0) -
          couponDiscount,
        couponCode: appliedCoupon ? appliedCoupon.code : undefined,
        couponDiscount,
        phoneNumber: normalizedPhoneNumber,
        isHomeDelivery: orderBody.isHomeDelivery,
        shippingLocation: normalizedShippingLocation,
        paymentMethod: orderBody.paymentMethod,
        paymentScreenshot,
        paymentScreenshotUploadedAt: paymentScreenshot ? new Date() : null,
        paymentChannel: orderBody.paymentChannel || undefined,
        paymentMode: normalizedPaymentMode || undefined,
        orderNote: orderBody.orderNote,
        deliveryPartner: orderBody.deliveryPartner,
      });

      const savedOrder = await newOrderData.save({ session });

      // Redeem the coupon inside the same transaction as the order
      if (appliedCoupon) {
        await Coupon.findByIdAndUpdate(
          appliedCoupon._id,
          {
            $inc: { usedCount: 1 },
            $push: {
              usedByUsers: {
                userId: orderBody.userId || undefined,
                productOrderId: orderIdForAttempt,
                discountAmount: couponDiscount,
                usedAt: new Date(),
              },
            },
          },
          { session }
        );
      }

      await session.commitTransaction();
      session.endSession();

      return {
        order: savedOrder,
        outOfStockProducts: attemptOutOfStockProducts,
      };
    } catch (error) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } catch (abortError) {
        // No-op: the session may already be finished if commit was the failure.
      }
      session.endSession();
      throw error;
    }
  };

  let createOrderedData;
  let outOfStockProducts = [];

  try {
    const created = await createWithUniqueOrderId({
      preferredOrderId: requestedOrderId,
      create: createOrderAttempt,
      onCollision: (collidedOrderId, _error, attemptNumber) => {
        console.warn(
          `[order] 5-digit order ID ${collidedOrderId} is already in use; retrying (attempt ${attemptNumber}).`
        );
      },
    });

    createOrderedData = created.order;
    outOfStockProducts = created.outOfStockProducts;
  } catch (error) {
    await removeUploadedScreenshot(screenshotFile);

    if (error instanceof OrderRequestError) {
      return res.status(error.status).json({ error: error.message, ...error.extra });
    }

    // Should not normally escape because createWithUniqueOrderId retries, but
    // keep a clear 409 response if the database reports a duplicate order ID.
    if (isDuplicateOrderIdError(error)) {
      return res.status(409).json({
        error: 'Could not allocate a unique order ID. Please retry the order.',
        productOrderId: requestedOrderId || undefined,
      });
    }

    if (error.code === 'ORDER_ID_UNAVAILABLE' || error.status === 503) {
      return res.status(503).json({ error: error.message });
    }

    return res.status(500).json({ error: error.message });
  }

  // The order is durably committed at this point. Respond first and notify
  // afterwards — the emails cost ~4s each on this SMTP host and the customer
  // should not be waiting on Gmail to see their order confirmation.
  console.log(createOrderedData._id, "created order data");
  res.status(201).json({
    data: createOrderedData,
    success: "Successfully Created Orders",
  });

  runAfterResponse(() => dispatchOrderNotifications(createOrderedData._id, outOfStockProducts));
};

// Issues a 5-digit reference for the checkout UI *before* payment, so the ID in
// the customer's payment remarks matches the order that is later created. This
// is only a preview; createOrder re-checks the value and retries on collision.
exports.generateOrderId = async (req, res) => {
  try {
    const orderId = await generateAvailableOrderId(Orders);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, orderId });
  } catch (error) {
    console.error('[order] could not generate an order ID:', error?.message || error);
    return res.status(503).json({
      success: false,
      error: 'Unable to generate a unique 5-digit order ID. Please try again.',
    });
  }
};

exports.getOrderedProductList = async (req, res) => {
  try {
    // Pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Search
    const search = req.query.search ? req.query.search.trim() : '';

    // Date filtering
    const dateFilterType = req.query.dateFilter || 'all';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let dateQuery = {};
    const now = new Date();
    if (dateFilterType !== 'all') {
      let start, end;
      if (dateFilterType === 'last1hour') {
        start = new Date(now.getTime() - 60 * 60 * 1000);
        end = now;
      } else if (dateFilterType === 'last2hour') {
        start = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        end = now;
      } else if (dateFilterType === 'last1day') {
        start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        end = now;
      } else if (dateFilterType === 'last7days') {
        start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        end = now;
      } else if (dateFilterType === 'custom' && startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        // Add 1 day to endDate to make it inclusive
        end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      }
      if (start && end) {
        dateQuery.date = { $gte: start, $lt: end };
      }
    }

    // Build search query
    let searchQuery = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      searchQuery = {
        $or: [
          { productOrderId: regex },
          { shippingLocation: regex },
          { locationAddress: regex },
          { paymentMethod: regex },
          { deliveryPartner: regex },
          { phoneNumber: regex },
          { name: regex },
          { fullName: regex },
        ]
      };
    }

    // Compose final query
    const query = {
      ...dateQuery,
      ...searchQuery,
    };

    // For searching inside user or products, need aggregation or populate+filter
    // For simplicity, fetch matching orders, then filter in-memory for user/product search

    // Get total count for pagination
    const totalCount = await Orders.countDocuments(query);

    // Fetch paginated orders
    let ordersList = await Orders.find(query)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "products.productId",
        model: "Product",
        populate: {
          path: "images",
          model: "ProductImage",
        },
      })
      .populate({
        path: "userId",
      });

    // If search includes user or product name, filter in-memory, then re-apply pagination
    let filteredOrders = ordersList;
    let filteredCount = totalCount;
    if (search) {
      const regex = new RegExp(search, 'i');
      filteredOrders = ordersList.filter(order => {
        // Customer name entered at checkout (order.name) is searchable on its
        // own; fullName is the older guest-checkout spelling of the same thing.
        if (order.name && regex.test(order.name)) return true;
        if (order.fullName && regex.test(order.fullName)) return true;
        // User fields
        if (order.userId) {
          if (order.userId.email && regex.test(order.userId.email)) return true;
          if (order.userId.name && regex.test(order.userId.name)) return true;
          if (order.userId.phone && regex.test(order.userId.phone)) return true;
        }
        // Product fields
        if (order.products && order.products.some(p => p.productId && p.productId.name && regex.test(p.productId.name))) return true;
        return (
          (order.productOrderId && regex.test(order.productOrderId)) ||
          (order.shippingLocation && regex.test(order.shippingLocation)) ||
          (order.locationAddress && regex.test(order.locationAddress)) ||
          (order.paymentMethod && regex.test(order.paymentMethod)) ||
          (order.deliveryPartner && regex.test(order.deliveryPartner)) ||
          (order.phoneNumber && regex.test(order.phoneNumber))
        );
      });
      filteredCount = filteredOrders.length;
      filteredOrders = filteredOrders.slice(0, limit); // Always return only the first page of filtered results
    }

    res.status(200).json({
      orders: search ? filteredOrders : ordersList,
      totalCount: search ? filteredCount : totalCount,
      page,
      limit,
      success: "successfully Got Orders"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateOrderedProduct = async (req, res) => {
  console.log( req.params.orderId, req.body, "update order data");
  try {
    const existingOrder = await findOrderByIdentifier(req.params.orderId);
    if (!existingOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }
    const requestedStatus = req.body?.status === undefined
      ? undefined
      : normalizeOrderStatus(req.body.status);
    if (req.body?.status !== undefined && !requestedStatus) {
      return res.status(400).json({
        message: 'Invalid order status',
        allowedStatuses: [...ORDER_STATUSES],
      });
    }

    const updateBody = { ...req.body };
    const statusNote = String(req.body?.statusNote || '').trim().slice(0, 500);
    delete updateBody.statusNote;
    if (requestedStatus) {
      updateBody.status = requestedStatus;
      updateBody.isConfirmed = requestedStatus !== 'pending' && requestedStatus !== 'cancelled';
      if (updateBody.isConfirmed && !updateBody.confirmedAt) {
        updateBody.confirmedAt = new Date();
      }
    }
    const { updatedOrder } = await confirmOrderAndSync(req.params.orderId, updateBody);

    if (requestedStatus && statusNote) {
      await Orders.updateOne(
        { _id: updatedOrder._id, 'statusHistory.status': requestedStatus, 'statusHistory.updatedAt': { $gte: new Date(Date.now() - 5000) } },
        { $set: { 'statusHistory.$.note': statusNote, 'statusHistory.$.updatedBy': 'admin' } }
      );
      updatedOrder.statusHistory = (updatedOrder.statusHistory || []).map((entry) =>
        entry.status === requestedStatus && !entry.note
          ? { ...(entry.toObject?.() || entry), note: statusNote, updatedBy: 'admin' }
          : entry
      );
    }

    res
      .status(201)
      .json({
        data: updatedOrder,
        message: "successfully updated Orders",
      });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.confirmOrdersBulk = async (req, res) => {
  try {
    const rawOrderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
    const normalizedOrderIds = [...new Set(
      rawOrderIds
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )];

    if (normalizedOrderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'orderIds is required and must be a non-empty array',
      });
    }

    const results = await mapWithConcurrency(
      normalizedOrderIds,
      CONFIRM_BULK_CONCURRENCY,
      async (orderId) => {
        const { found, updatedOrder } = await confirmOrderAndSync(orderId, {
          isConfirmed: true,
          confirmedAt: new Date(),
        });

        if (!found) {
          return {
            orderId,
            inputIdentifier: orderId,
            success: false,
            error: 'Order not found',
          };
        }

        return {
          orderId: String(updatedOrder?._id || orderId),
          inputIdentifier: orderId,
          productOrderId: updatedOrder?.productOrderId || null,
          success: true,
          isConfirmed: updatedOrder?.isConfirmed === true,
        };
      }
    );

    const successCount = results.filter((item) => item.success).length;
    const failureCount = results.length - successCount;

    return res.status(failureCount > 0 ? 207 : 200).json({
      success: failureCount === 0,
      message: failureCount > 0
        ? `Partially confirmed: ${successCount} succeeded, ${failureCount} failed`
        : `Successfully confirmed ${successCount} order(s)`,
      results,
      summary: {
        total: results.length,
        successful: successCount,
        failed: failureCount,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Bulk confirmation failed' });
  }
};

exports.deleteSpecificCartOrder = async (req, res) => {
  try {
    const orderId = req.params.orderId || req.params.id || req.params.userId;
    const deletedOrder = await Orders.findByIdAndDelete(orderId);

    if (!deletedOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Order deleted successfully",
      order: deletedOrder
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getOrderDetails = async (req, res) => {
  try {
    const { productOrderId } = req.params;

    console.log(productOrderId, req.params, "-----productOrderId----");

    const orderDetails = await Orders.findOne({ productOrderId: productOrderId })
      .populate({
        path: "products.productId",
        model: "Product",
        populate: {
          path: "images",
          model: "ProductImage",
        },
      })
      .populate({
        path: "userId",
        model: "User",
      });

    if (!orderDetails) {
      return res
        .status(404)
        .json({ error: `Order with productOrderId ${productOrderId} not found` });
    }

    res.status(200).json({
      data: orderDetails,
      success: "Successfully retrieved order details",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Additional endpoint to manually check and send out-of-stock notifications
exports.checkOutOfStockProducts = async (req, res) => {
  try {
    const outOfStockProducts = await Product.find({ 
      stockQuantity: 0, 
      outOfStockNotificationSent: false 
    });

    let notificationsSent = 0;

    if (outOfStockProducts.length > 0) {
      // Convert to the format expected by sendOutOfStockNotification
      const newOutOfStockProducts = outOfStockProducts.map(product => ({
        ...product.toObject(),
        previousStock: product.stockQuantity + 1, // Estimate previous stock
        orderedQuantity: 1 // Default quantity
      }));

      const sent = await sendOutOfStockNotification(newOutOfStockProducts);
      if (sent) {
        for (const product of outOfStockProducts) {
          await Product.findByIdAndUpdate(product._id, { 
            outOfStockNotificationSent: true 
          });
        }
        notificationsSent = outOfStockProducts.length;
      }
    }

    res.status(200).json({
      message: `Out-of-stock check completed. ${notificationsSent} notifications sent.`,
      outOfStockProducts: outOfStockProducts.length,
      notificationsSent
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Every product currently out of stock, newest sales first.
// Shared by the report endpoint and the bulk stock endpoint so both agree on
// exactly which products are "out of stock" and in which order.
const OUT_OF_STOCK_SORT = { totalSales: -1, lastSoldAt: -1 };

const findOutOfStockProducts = () =>
  Product.find({ stockQuantity: { $lte: 0 } })
    .populate('category')
    .populate('subCategory')
    .sort(OUT_OF_STOCK_SORT);

// The report filters in Node (category/sub-category live behind a populate),
// so a single query is loaded and narrowed here. Regex-escaped because the
// term comes straight from a query string.
const filterOutOfStockBySearch = (products, search) => {
  const term = search ? String(search).trim() : '';
  if (!term) return products;

  const escapedSearch = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedSearch, 'i');
  return products.filter(
    (product) =>
      (product.name && regex.test(product.name)) ||
      (product.category?.name && regex.test(product.category.name)) ||
      (product.subCategory?.name && regex.test(product.subCategory.name))
  );
};

// New endpoint to get complete out-of-stock report
exports.getOutOfStockReport = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;
    const search = req.query.search ? String(req.query.search).trim() : '';

    const allOutOfStockProducts = await findOutOfStockProducts();

    const filteredProducts = filterOutOfStockBySearch(
      allOutOfStockProducts,
      search
    );

    const total = filteredProducts.length;
    const paginatedProducts = filteredProducts.slice(skip, skip + limit);

    res.status(200).json({
      data: paginatedProducts,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      summary: {
        total,
        highSales: allOutOfStockProducts.filter((p) => (p.totalSales || 0) >= 50).length,
        notificationPending: allOutOfStockProducts.filter((p) => !p.outOfStockNotificationSent).length,
      },
      success: "Successfully retrieved out-of-stock report",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Bulk-set the stock quantity of out-of-stock products in one shot.
//
// Two scopes:
//   "selected" → exactly the productIds in the body
//   "all"      → every currently out-of-stock product (optionally narrowed by
//                the same `search` the table is filtered by)
//
// A product is only ever *moved into* a new stock count here, so a `stockQuantity`
// of 0 is a valid no-op-ish request but anything else always means "back in stock".
// Restocked products are queued for the same restock-notification fan-out the
// single-product update path triggers, otherwise subscribers would wait forever.
exports.bulkUpdateOutOfStock = async (req, res) => {
  try {
    const { productIds, stockQuantity, scope = 'selected', search } = req.body || {};
    const targetScope = scope === 'all' ? 'all' : 'selected';

    // Number(null) and Number('') are both 0, so an omitted/blank quantity
    // would silently mean "zero out the inventory". Reject those up front.
    if (
      stockQuantity === null ||
      stockQuantity === undefined ||
      stockQuantity === '' ||
      typeof stockQuantity === 'boolean'
    ) {
      return res.status(400).json({ error: "stockQuantity is required" });
    }

    const stock = Number(stockQuantity);
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({
        error: "stockQuantity must be a whole number greater than or equal to 0",
      });
    }
    if (stock > 1_000_000) {
      return res.status(400).json({
        error: "stockQuantity must be 1,000,000 or less",
      });
    }

    let ids = [];

    if (targetScope === 'all') {
      const outOfStockProducts = filterOutOfStockBySearch(
        await findOutOfStockProducts(),
        search
      );
      ids = outOfStockProducts.map((product) => product._id);
    } else {
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: "Product IDs array is required" });
      }

      // Drop anything that is not a well-formed ObjectId so one bad value can
      // never take the whole request down with a CastError. Dedup on the raw
      // string first — a Set of ObjectId wrappers would never collapse, since
      // each constructor call yields a distinct reference.
      ids = [
        ...new Set(
          productIds
            .map((id) => String(id))
            .filter((id) => mongoose.isValidObjectId(id))
        ),
      ].map((id) => new mongoose.Types.ObjectId(id));

      if (ids.length === 0) {
        return res.status(400).json({ error: "No valid product IDs provided" });
      }
    }

    if (ids.length === 0) {
      return res.status(200).json({
        success: true,
        matchedCount: 0,
        modifiedCount: 0,
        stockQuantity: stock,
        restocked: 0,
        message: "No out-of-stock products matched. Nothing was updated.",
      });
    }

    // outOfStockNotificationSent is a per-stockout-cycle flag. Leaving it true
    // after a restock means the *next* stockout would never alert anyone, so
    // reset it for every product that is back in stock.
    const update = { $set: { stockQuantity: stock } };
    if (stock > 0) {
      update.$set.outOfStockNotificationSent = false;
    }

    const result = await Product.updateMany({ _id: { $in: ids } }, update);

    let restocked = 0;
    if (stock > 0 && result.modifiedCount > 0) {
      restocked = result.modifiedCount;
      // Non-blocking: the response must not wait on SMTP. Guarded so a failure
      // here can never become an unhandled rejection that takes the process down.
      runAfterResponse(() =>
        Promise.all(
          ids.map((id) => notifySubscribersOfRestock(id))
        ).then((results) => {
          const notified = results.reduce(
            (sum, entry) => sum + (entry?.notified || 0),
            0
          );
          if (notified > 0) {
            console.log(
              `[Restock][bulk] ${notified} subscriber(s) notified across ${ids.length} product(s).`
            );
          }
        })
      );
    }

    res.status(200).json({
      success: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      stockQuantity: stock,
      restocked,
      message: `Successfully updated stock to ${stock} for ${result.modifiedCount} product(s)`,
    });
  } catch (error) {
    console.error("Error bulk updating out-of-stock products:", error);
    res.status(500).json({ error: error.message });
  }
};

// Add the same amount of stock to EVERY product in the catalog, in one shot.
//
// This is deliberately an increment ($inc) and not a set: the dashboard field
// asks "add N items to each product", so a product sitting at 3 becomes 3+N and
// a product at 0 becomes N. Use the bulk-stock endpoint above when the target is
// an exact quantity instead.
//
// Only products that were actually at zero are emailed, since those are the
// ones a waiting subscriber cares about — a product going from 12 to 12+N has
// never been out of stock and needs no notification.
exports.increaseStockForAllProducts = async (req, res) => {
  try {
    const { quantity } = req.body || {};

    // Number(null)/Number('') are both 0, so an omitted value would otherwise
    // look like "add nothing" and silently report success. Reject it instead.
    if (
      quantity === null ||
      quantity === undefined ||
      quantity === '' ||
      typeof quantity === 'boolean'
    ) {
      return res.status(400).json({ error: "quantity is required" });
    }

    const amount = Number(quantity);
    if (!Number.isInteger(amount) || amount < 1) {
      return res.status(400).json({
        error: "quantity must be a whole number of at least 1",
      });
    }
    if (amount > 1_000_000) {
      return res.status(400).json({ error: "quantity must be 1,000,000 or less" });
    }

    // Captured before the increment: these are exactly the products that cross
    // from 0 into stock because of this change.
    const wasOutOfStock = await Product.find(
      { stockQuantity: { $lte: 0 } },
      { _id: 1 }
    ).lean();
    const restockedIds = wasOutOfStock.map((product) => product._id);

    // outOfStockNotificationSent is a per-stockout-cycle flag. Resetting it keeps
    // the next stockout able to alert people, exactly like the bulk-set path.
    const result = await Product.updateMany(
      {},
      {
        $inc: { stockQuantity: amount },
        $set: { outOfStockNotificationSent: false },
      }
    );

    if (restockedIds.length > 0) {
      // Non-blocking: the response must not wait on SMTP. runAfterResponse
      // swallows failures so a bad address can never take the process down.
      runAfterResponse(() =>
        Promise.all(
          restockedIds.map((id) => notifySubscribersOfRestock(id))
        ).then((entries) => {
          const notified = entries.reduce(
            (sum, entry) => sum + (entry?.notified || 0),
            0
          );
          if (notified > 0) {
            console.log(
              `[Restock][all] ${notified} subscriber(s) notified across ${restockedIds.length} product(s).`
            );
          }
        })
      );
    }

    res.status(200).json({
      success: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      quantity: amount,
      restocked: restockedIds.length,
      message: `Added ${amount} to the stock of ${result.modifiedCount} product(s)`,
    });
  } catch (error) {
    console.error("Error increasing stock for all products:", error);
    res.status(500).json({ error: error.message });
  }
};

// New endpoint to send complete out-of-stock report via email
exports.sendOutOfStockReportEmail = async (req, res) => {
  try {
    const sent = await sendCompleteOutOfStockReport();
    
    if (sent) {
      res.status(200).json({
        message: "Complete out-of-stock report sent successfully via email",
        success: true
      });
    } else {
      res.status(500).json({
        error: "Failed to send out-of-stock report email"
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getOrdersByUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const orders = await Orders.find({ userId })
      .sort({ date: -1 })
      .populate({
        path: 'products.productId',
        model: 'Product',
        populate: {
          path: 'images',
          model: 'ProductImage',
        },
      })
      .populate({ path: 'userId', model: 'User' });

    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to fetch user orders' });
  }
};