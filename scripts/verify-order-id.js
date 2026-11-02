/* eslint-disable no-console */
/**
 * Unit-level verification for the 5-digit order ID implementation.
 * No database or network needed.
 *
 * Run with: npm run verify:order-id
 */
const assert = require('assert');
const {
  formatOrderId,
  isValidOrderId,
  normalizeOrderId,
  generateOrderIdCandidate,
  generateAvailableOrderId,
  createWithUniqueOrderId,
} = require('../utils/orderId.util');

const duplicateError = () => {
  const error = new Error('E11000 duplicate key error collection: orders');
  error.code = 11000;
  error.keyPattern = { productOrderId: 1 };
  error.keyValue = { productOrderId: 'taken' };
  return error;
};

const run = async () => {
  console.log('1. Format and leading-zero handling');
  assert.strictEqual(formatOrderId(0), '00000');
  assert.strictEqual(formatOrderId(17), '00017');
  assert.strictEqual(formatOrderId(99999), '99999');
  assert.strictEqual(isValidOrderId('00017'), true);
  assert.strictEqual(isValidOrderId('10245'), true);
  assert.strictEqual(isValidOrderId('1234'), false);
  assert.strictEqual(isValidOrderId('123456'), false);
  assert.strictEqual(isValidOrderId('12a45'), false);
  assert.strictEqual(isValidOrderId(10245), false);
  assert.strictEqual(normalizeOrderId(' 00017 '), '00017');
  assert.strictEqual(normalizeOrderId('abcde'), null);
  console.log('   ok');

  console.log('2. Generated candidates are always exactly 5 numeric digits');
  const seen = new Set();
  for (let index = 0; index < 20000; index += 1) {
    const candidate = generateOrderIdCandidate();
    assert.match(candidate, /^\d{5}$/);
    seen.add(candidate);
  }
  // With 100000 possibilities, 20000 draws yield ~18126 distinct values
  // (birthday collisions are expected). Assert reasonable variation plus at
  // least one leading-zero ID, which proves padding is not stripped.
  assert.ok(seen.size >= 17800, `unexpectedly low variation: ${seen.size}`);
  assert.ok([...seen].some((candidate) => candidate.startsWith('0')));
  console.log(`   ok (${seen.size} distinct values across 20000 draws)`);

  console.log('3. Preview endpoint skips IDs already used by an order');
  const existing = new Set(['11111', '22222']);
  const queue = ['11111', '22222', '33333'];
  let queueIndex = 0;
  const previewId = await generateAvailableOrderId(
    {
      exists: async ({ productOrderId }) => existing.has(productOrderId),
    },
    { generateCandidate: () => queue[queueIndex++] || '33333' }
  );
  assert.strictEqual(previewId, '33333');
  console.log('   ok');

  console.log('4. Duplicate-key collisions are retried with a fresh ID');
  const taken = new Set(['00017', '11111']);
  const retryQueue = ['00017', '11111', '58321'];
  let retryIndex = 0;
  let collisions = 0;
  const created = await createWithUniqueOrderId({
    preferredOrderId: '00017',
    generateCandidate: () => retryQueue[retryIndex++] || '58321',
    onCollision: () => {
      collisions += 1;
    },
    create: async (candidate) => {
      if (taken.has(candidate)) throw duplicateError();
      taken.add(candidate);
      return { orderId: candidate };
    },
  });
  assert.strictEqual(created.orderId, '58321');
  assert.strictEqual(collisions, 2);
  console.log('   ok (two forced collisions, final ID 58321)');

  console.log('5. Concurrent creation never returns the same ID twice');
  const concurrentTaken = new Set();
  const total = 500;
  const results = await Promise.all(
    Array.from({ length: total }, () =>
      createWithUniqueOrderId({
        create: async (candidate) => {
          // Random delay widens the race window.
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 8));
          if (concurrentTaken.has(candidate)) throw duplicateError();
          concurrentTaken.add(candidate);
          return candidate;
        },
      })
    )
  );

  assert.strictEqual(results.length, total);
  assert.strictEqual(new Set(results).size, total);
  results.forEach((orderId) => assert.match(orderId, /^\d{5}$/));
  assert.strictEqual(new Set(results).size, concurrentTaken.size);
  console.log(`   ok (${total} concurrent creations, ${new Set(results).size} unique IDs)`);

  console.log('\nAll 5-digit order ID unit checks passed.');
};

run().catch((error) => {
  console.error('\nOrder ID verification failed:', error?.stack || error);
  process.exit(1);
});
