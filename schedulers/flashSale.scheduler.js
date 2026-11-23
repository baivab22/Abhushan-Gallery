const {syncCampaignStatuses} = require('../services/flashSale.service');

const DEFAULT_INTERVAL_MS = 30 * 1000;
let intervalHandle = null;
let sweepRunning = false;

const runFlashSaleSweep = async () => {
  if (sweepRunning) return {skipped: true};
  sweepRunning = true;
  try {
    return await syncCampaignStatuses({force: true});
  } catch (error) {
    console.error('[FlashSale Scheduler] Sweep failed:', error?.message || error);
    return {error: String(error?.message || error)};
  } finally {
    sweepRunning = false;
  }
};

function startFlashSaleSchedulers() {
  if (intervalHandle) return intervalHandle;

  const intervalMs = Math.max(
    10 * 1000,
    Number(process.env.FLASH_SALE_SCHEDULER_INTERVAL_MS) || DEFAULT_INTERVAL_MS
  );
  console.log(`[FlashSale] Scheduler started (every ${intervalMs / 1000}s)`);

  // Start due campaigns promptly on boot, then keep checking for expiry.
  setTimeout(() => {
    runFlashSaleSweep();
  }, 2 * 1000).unref?.();

  intervalHandle = setInterval(() => {
    runFlashSaleSweep();
  }, intervalMs);
  intervalHandle.unref?.();

  return intervalHandle;
}

module.exports = {startFlashSaleSchedulers, runFlashSaleSweep};
