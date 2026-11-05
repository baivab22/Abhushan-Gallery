/**
 * End-to-end verification for the "Notify Me" / back-in-stock flow.
 *
 * It creates a throw-away product (stock 0) and user, subscribes the user,
 * then drives the REAL product-update controller to raise the stock. The mailer
 * is stubbed, so no email is sent. Everything is deleted afterwards.
 *
 *   cd server
 *   CONFIRM_RESTOCK_VERIFY=true npm run verify:restock
 *
 * The guard exists because the script writes to the database configured in
 * server/.env. Run it against staging/local when possible.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const assert = require("assert");
const mongoose = require("mongoose");

const run = async () => {
  if (process.env.CONFIRM_RESTOCK_VERIFY !== "true") {
    console.error(
      "Refusing to run: set CONFIRM_RESTOCK_VERIFY=true to allow the temporary DB writes."
    );
    process.exit(1);
  }

  const emailServices = require("../services/emailServices");
  const outbox = [];
  // Must be stubbed BEFORE the restock service is required, because it
  // destructures this function at module load time.
  emailServices.sendRestockAvailableEmail = async (email, product) => {
    outbox.push({ email, productName: product.name });
    return true;
  };

  const User = require("../modals/userModal");
  const { Product } = require("../modals/product.modal");
  const RestockNotification = require("../modals/restockNotification.modal");
  const {
    subscribeUserToRestock,
    didRestock,
  } = require("../services/restockNotification.service");
  const { updateProduct } = require("../controllers/product.controller");

  const configuredMin = Math.floor(Number(process.env.RESTOCK_NOTIFY_MIN_STOCK));
  const minStock = Number.isFinite(configuredMin) && configuredMin > 0 ? configuredMin : 1;
  const targetStock = Math.max(2, minStock);

  // Pure transition checks first, so a regression is obvious.
  assert.strictEqual(didRestock(0, minStock), true, `0 -> ${minStock} must alert`);
  assert.strictEqual(didRestock(0, targetStock), true, `0 -> ${targetStock} must alert`);
  assert.strictEqual(didRestock(-2, minStock), true, `-2 -> ${minStock} must alert`);
  assert.strictEqual(
    didRestock(undefined, targetStock),
    true,
    `missing -> ${targetStock} must alert`
  );
  if (minStock > 1) {
    assert.strictEqual(
      didRestock(0, minStock - 1),
      false,
      `0 -> ${minStock - 1} must not alert at this threshold`
    );
  }
  assert.strictEqual(didRestock(5, 10), false, "5 -> 10 must not alert");
  assert.strictEqual(didRestock(0, 0), false, "0 -> 0 must not alert");
  assert.strictEqual(didRestock(0, -1), false, "0 -> -1 must not alert");

  await mongoose.connect(process.env.DBHOST);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let user = null;
  let product = null;

  try {
    user = await User.create({
      name: "Restock Verification",
      email: `restock-verify-${suffix}@example.invalid`,
      password: `verification-only-${suffix}`,
      status: "active",
    });

    product = await Product.create({
      name: `ZZ_RESTOCK_VERIFY_${suffix}`,
      price: 100,
      stockQuantity: 0,
      images: [],
      isHotSelling: false,
    });

    const subscription = await subscribeUserToRestock({
      userId: user._id,
      productId: product._id,
    });
    assert.strictEqual(subscription.subscribed, true, "subscription must be saved");

    // Drive the real controller: stock 0 -> 2 must notify the subscriber.
    let statusCode = null;
    const req = {
      params: { productId: String(product._id) },
      body: { stockQuantity: String(targetStock) },
      files: [],
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };

    await updateProduct(req, res);
    assert.strictEqual(statusCode, 200, "product update must succeed");

    let notification = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      notification = await RestockNotification.findOne({
        userId: user._id,
        productId: product._id,
      })
        .sort({ createdAt: -1 })
        .lean();
      if (notification && notification.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert(notification, "a restock notification record must exist");
    assert.strictEqual(notification.status, "sent", "notification must be sent");
    assert.strictEqual(outbox.length, 1, "exactly one email must be produced");
    assert.strictEqual(outbox[0].email, user.email, "email must target the subscriber");

    const savedProduct = await Product.findById(product._id)
      .select("stockQuantity")
      .lean();
    assert.strictEqual(
      savedProduct.stockQuantity,
      targetStock,
      "stock must be persisted"
    );

    console.log(
      `PASS: 0 -> ${targetStock} restock produced exactly one subscriber email.`
    );
  } finally {
    if (product) {
      await RestockNotification.deleteMany({ productId: product._id });
      await Product.deleteOne({ _id: product._id });
    }
    if (user) await User.deleteOne({ _id: user._id });
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
});
