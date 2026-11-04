const {
  processDueRestockNotifications,
} = require("../services/restockNotification.service");

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const DEFAULT_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;

let intervalHandle = null;
let startupHandle = null;
let sweepRunning = false;

const isDisabled = () =>
  String(process.env.RESTOCK_WORKER_ENABLED || "")
    .trim()
    .toLowerCase() === "false";

/**
 * One sweep: deliver pending restock emails whose product is back in stock.
 * Safe to call manually (tests, scripts) and safe to overlap with the HTTP
 * trigger — the per-subscriber claim prevents duplicate emails.
 */
const runRestockNotificationSweep = async () => {
  if (sweepRunning) return { skipped: true };
  sweepRunning = true;
  try {
    return await processDueRestockNotifications();
  } catch (error) {
    console.error(
      "[Restock][worker] Sweep failed:",
      error?.message || error
    );
    return { error: String(error?.message || error) };
  } finally {
    sweepRunning = false;
  }
};

/**
 * Start the retry/self-healing worker. This is deliberately a safety net, not
 * the primary path: stock updates still notify immediately. The worker exists
 * so a missed trigger (server restart, crash mid-send, temporary SMTP failure)
 * can never leave a shopper's pending alert stranded forever.
 */
const startRestockNotificationWorker = () => {
  if (isDisabled()) {
    console.log("[Restock][worker] Disabled via RESTOCK_WORKER_ENABLED=false");
    return null;
  }
  if (intervalHandle) return intervalHandle;

  const intervalMs = Math.max(
    15 * 1000,
    toPositiveInt(process.env.RESTOCK_WORKER_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  );

  console.log(
    `[Restock][worker] Started (sweep every ${Math.round(intervalMs / 1000)}s)`
  );

  // Recover anything left pending by a previous process shortly after boot.
  startupHandle = setTimeout(() => {
    runRestockNotificationSweep();
  }, STARTUP_DELAY_MS);
  startupHandle.unref?.();

  intervalHandle = setInterval(() => {
    runRestockNotificationSweep();
  }, intervalMs);
  intervalHandle.unref?.();

  return intervalHandle;
};

const stopRestockNotificationWorker = () => {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
};

module.exports = {
  startRestockNotificationWorker,
  stopRestockNotificationWorker,
  runRestockNotificationSweep,
};
