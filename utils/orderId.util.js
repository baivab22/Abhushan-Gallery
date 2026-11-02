const crypto = require('crypto');

// Public-facing order reference. Kept as a string everywhere so leading zeros
// survive (`00017`), and deliberately kept separate from Mongo's `_id`.
const ORDER_ID_LENGTH = 5;
const ORDER_ID_SPACE = 10 ** ORDER_ID_LENGTH; // 100000 possible values
const ORDER_ID_PATTERN = /^\d{5}$/;
const DEFAULT_MAX_ATTEMPTS = 25;

const isValidOrderId = (value) =>
  typeof value === 'string' && ORDER_ID_PATTERN.test(value);

const normalizeOrderId = (value) => {
  const candidate = String(value ?? '').trim();
  return isValidOrderId(candidate) ? candidate : null;
};

const formatOrderId = (numericValue) =>
  String(numericValue).padStart(ORDER_ID_LENGTH, '0');

// crypto.randomInt gives an unbiased value in [0, ORDER_ID_SPACE).
const generateOrderIdCandidate = () =>
  formatOrderId(crypto.randomInt(0, ORDER_ID_SPACE));

const isDuplicateOrderIdError = (error) =>
  Boolean(
    error &&
      error.code === 11000 &&
      (error.keyPattern?.productOrderId ||
        /productOrderId/i.test(String(error.message || '')))
  );

const buildExhaustionError = () => {
  const error = new Error(
    'Unable to allocate a unique 5-digit order ID. Please try again.'
  );
  error.code = 'ORDER_ID_UNAVAILABLE';
  error.status = 503;
  return error;
};

// Used by the pre-checkout endpoint so the customer sees the same ID that will
// be written to their order. This is only a preview/availability check; the
// unique index in MongoDB is still the real source of truth.
const generateAvailableOrderId = async (
  Orders,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS, generateCandidate = generateOrderIdCandidate } = {}
) => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateCandidate();
    if (!isValidOrderId(candidate)) continue;

    const exists = await Orders.exists({ productOrderId: candidate });
    if (!exists) return candidate;
  }

  throw buildExhaustionError();
};

// Runs `create(candidateId)` and retries with a fresh candidate whenever the
// database's unique index rejects a duplicate. `create` is expected to own its
// transaction/session and to leave no partial writes behind when it throws.
const createWithUniqueOrderId = async ({
  preferredOrderId,
  create,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  generateCandidate = generateOrderIdCandidate,
  onCollision,
}) => {
  const attempted = new Set();
  let candidate = normalizeOrderId(preferredOrderId);

  const pickFreshCandidate = () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const next = generateCandidate();
      if (isValidOrderId(next) && !attempted.has(next)) return next;
    }
    return null;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!candidate || attempted.has(candidate)) {
      candidate = pickFreshCandidate();
    }
    if (!candidate) break;

    attempted.add(candidate);

    try {
      return await create(candidate);
    } catch (error) {
      if (isDuplicateOrderIdError(error)) {
        onCollision?.(candidate, error, attempt);
        candidate = null;
        continue;
      }

      throw error;
    }
  }

  throw buildExhaustionError();
};

module.exports = {
  ORDER_ID_LENGTH,
  ORDER_ID_PATTERN,
  formatOrderId,
  generateOrderIdCandidate,
  normalizeOrderId,
  isValidOrderId,
  isDuplicateOrderIdError,
  generateAvailableOrderId,
  createWithUniqueOrderId,
};
