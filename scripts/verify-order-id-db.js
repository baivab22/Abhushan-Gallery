/* eslint-disable no-console */
/**
 * Database-level verification for the 5-digit order ID implementation.
 *
 * Uses a throwaway test database and cleans up after itself. It refuses to run
 * against a database name that does not look like a test database unless the
 * caller explicitly opts in.
 *
 * Run with:
 *   ORDER_ID_TEST_MONGO_URI=mongodb://127.0.0.1:27017/order_id_verification npm run verify:order-id-db
 */
const assert = require('assert');
const mongoose = require('mongoose');
const Orders = require('../modals/orderModal');
const { createWithUniqueOrderId } = require('../utils/orderId.util');

const TEST_URI =
  process.env.ORDER_ID_TEST_MONGO_URI ||
  'mongodb://127.0.0.1:27017/order_id_verification';

const duplicateError = () => {
  const error = new Error('E11000 duplicate key error collection: orders');
  error.code = 11000;
  error.keyPattern = { productOrderId: 1 };
  return error;
};

const buildOrder = (productOrderId) =>
  new Orders({
    productOrderId,
    shippingLocation: 'Order ID verification address',
    phoneNumber: '9800000000',
    products: [],
  });

const run = async () => {
  if (!/test|verification|verify/i.test(TEST_URI) && process.env.ALLOW_NON_TEST_DB !== '1') {
    throw new Error(
      'Refusing to run against a non-test database. Set ALLOW_NON_TEST_DB=1 to override.'
    );
  }

  console.log(`Connecting to ${TEST_URI}`);
  await mongoose.connect(TEST_URI);
  await Orders.deleteMany({});
  await Orders.ensureIndexes();

  try {
    console.log('1. Unique index exists on productOrderId');
    const indexes = await Orders.collection.indexes();
    const uniqueIndex = indexes.find(
      (index) => index.key && index.key.productOrderId === 1
    );
    assert.ok(uniqueIndex, 'productOrderId index was not created');
    assert.strictEqual(uniqueIndex.unique, true, 'productOrderId index is not unique');
    console.log(`   ok (${uniqueIndex.name})`);

    console.log('2. Leading-zero IDs are stored as strings');
    const zeroOrder = await buildOrder('00017').save();
    assert.strictEqual(zeroOrder.productOrderId, '00017');
    assert.notStrictEqual(String(zeroOrder._id), zeroOrder.productOrderId);
    console.log(`   ok (_id=${zeroOrder._id} productOrderId=${zeroOrder.productOrderId})`);

    console.log('3. A duplicate ID is rejected by MongoDB');
    let duplicateRejected = false;
    try {
      await buildOrder('00017').save();
    } catch (error) {
      duplicateRejected = error.code === 11000;
    }
    assert.strictEqual(duplicateRejected, true, 'duplicate ID was not rejected');
    console.log('   ok (E11000)');

    console.log('4. Concurrent inserts of the same ID: exactly one wins');
    const sameIdResults = await Promise.allSettled(
      Array.from({ length: 10 }, () => buildOrder('12345').save())
    );
    const sameIdSuccesses = sameIdResults.filter(
      (result) => result.status === 'fulfilled'
    );
    const sameIdDuplicates = sameIdResults.filter(
      (result) =>
        result.status === 'rejected' && result.reason?.code === 11000
    );
    assert.strictEqual(sameIdSuccesses.length, 1);
    assert.strictEqual(sameIdDuplicates.length, 9);
    console.log('   ok (1 success, 9 duplicate-key rejections)');

    console.log('5. 250 concurrent full creations receive unique 5-digit IDs');
    const total = 250;
    const createdOrders = await Promise.all(
      Array.from({ length: total }, () =>
        createWithUniqueOrderId({
          create: async (candidate) => {
            // Simulate work before the unique-index check.
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
            try {
              return await buildOrder(candidate).save();
            } catch (error) {
              if (error.code === 11000) throw duplicateError();
              throw error;
            }
          },
        })
      )
    );

    const ids = createdOrders.map((order) => order.productOrderId);
    assert.strictEqual(ids.length, total);
    assert.strictEqual(new Set(ids).size, total);
    ids.forEach((orderId) => assert.match(orderId, /^\d{5}$/));

    const dbCount = await Orders.countDocuments({});
    assert.strictEqual(dbCount, 2 + total); // 00017 + 12345 + concurrent batch
    console.log(`   ok (${total} unique IDs, ${dbCount} documents in test collection)`);

    console.log('6. Existing long IDs remain valid alongside new 5-digit IDs');
    const legacyOrder = await buildOrder('AG-2026-00142').save();
    assert.strictEqual(legacyOrder.productOrderId, 'AG-2026-00142');
    console.log('   ok (legacy ID preserved)');

    console.log('\nAll database-level order ID checks passed.');
  } finally {
    await Orders.deleteMany({});
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error('\nOrder ID database verification failed:', error?.stack || error);
  process.exit(1);
});
