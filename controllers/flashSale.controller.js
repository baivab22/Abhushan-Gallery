const FlashSale = require('../modals/flashSale.modal');
const {
  DEFAULT_PUBLIC_LIMIT,
  FlashSaleError,
  syncCampaignStatuses,
  assertNoConflictingCampaign,
  getActiveCampaign,
  getCampaignProducts,
  buildPublicPayload,
  normalizeCampaignPayload,
  applyCampaignToProducts,
  restoreCampaignProducts,
} = require('../services/flashSale.service');

const sendError = (res, error, fallbackMessage) => {
  if (error instanceof FlashSaleError) {
    return res.status(error.status).json({success: false, message: error.message});
  }
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return res.status(400).json({success: false, message: error.message});
  }
  console.error('[FlashSale] Controller error:', error);
  return res.status(500).json({
    success: false,
    message: error?.message || fallbackMessage || 'Flash sale request failed.',
  });
};

const safeSync = async (options) => {
  try {
    return await syncCampaignStatuses(options);
  } catch (error) {
    console.error('[FlashSale] Status sync failed:', error?.message || error);
    return null;
  }
};

// ───────────────────────────── Public ─────────────────────────────

// Drives the homepage countdown and deal grid. All times come from the server
// so a customer's device clock cannot speed up or extend a campaign.
exports.getActiveFlashSale = async (req, res) => {
  try {
    await safeSync();

    const campaign = await getActiveCampaign();
    if (!campaign) {
      return res.status(200).json({
        success: true,
        message: 'No active flash sale.',
        data: null,
        serverNow: new Date().toISOString(),
      });
    }

    const productsResult = await getCampaignProducts(campaign, {
      page: req.query.page,
      limit: req.query.limit || DEFAULT_PUBLIC_LIMIT,
    });

    return res.status(200).json({
      success: true,
      message: 'Active flash sale retrieved.',
      data: buildPublicPayload(campaign, productsResult),
    });
  } catch (error) {
    return sendError(res, error, 'Could not load the active flash sale.');
  }
};

// ───────────────────────────── Admin ─────────────────────────────

exports.getAllCampaignsAdmin = async (req, res) => {
  try {
    await safeSync({force: true});

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const search = String(req.query.search || '').trim();
    const statusFilter = String(req.query.status || '').trim().toLowerCase();

    const query = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.name = {$regex: escaped, $options: 'i'};
    }
    if (['scheduled', 'active', 'paused', 'expired'].includes(statusFilter)) {
      query.status = statusFilter;
    }

    const total = await FlashSale.countDocuments(query);
    const campaigns = await FlashSale.find(query)
      .populate('categoryIds', 'name')
      .populate('categoryDiscounts.category', 'name')
      .populate('createdBy', 'name email')
      .sort({createdAt: -1})
      .skip((page - 1) * limit)
      .limit(limit);

    const counts = await FlashSale.aggregate([
      {$group: {_id: '$status', count: {$sum: 1}}},
    ]);
    const statusCounts = {active: 0, scheduled: 0, paused: 0, expired: 0};
    counts.forEach((item) => {
      if (item._id in statusCounts) statusCounts[item._id] = item.count;
    });

    return res.status(200).json({
      success: true,
      message: 'Flash sales retrieved.',
      data: campaigns,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: statusCounts,
    });
  } catch (error) {
    return sendError(res, error, 'Could not load flash sales.');
  }
};

exports.createCampaign = async (req, res) => {
  try {
    const payload = normalizeCampaignPayload(req.body || {});

    // Expire/start anything due before checking for a second effective sale.
    await safeSync({force: true});
    await assertNoConflictingCampaign();

    const now = new Date();
    let status = 'scheduled';
    if (payload.endsAt <= now) status = 'expired';
    else if (payload.startsAt <= now) status = 'active';

    const campaign = await FlashSale.create({
      ...payload,
      status,
      createdBy: req.user?.userId || null,
      appliedAt: status === 'active' ? now : null,
    });

    if (status === 'active') {
      const applied = await applyCampaignToProducts(campaign);
      campaign.appliedProductCount = applied.appliedCount;
      await campaign.save();
    }

    return res.status(201).json({
      success: true,
      message:
        status === 'active'
          ? `Flash sale is live. Discount applied to ${campaign.appliedProductCount} product(s).`
          : status === 'scheduled'
            ? 'Flash sale scheduled. Discounts will apply automatically at the start time.'
            : 'Flash sale created with a past end time; no discounts were applied.',
      data: campaign,
    });
  } catch (error) {
    return sendError(res, error, 'Could not create the flash sale.');
  }
};

exports.updateCampaign = async (req, res) => {
  try {
    const campaign = await FlashSale.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({success: false, message: 'Flash sale not found.'});
    }

    await safeSync({force: true});
    const fresh = await FlashSale.findById(req.params.id);
    if (!fresh) {
      return res.status(404).json({success: false, message: 'Flash sale not found.'});
    }

    const merged = {...fresh.toObject(), ...(req.body || {})};
    const payload = normalizeCampaignPayload(merged);
    await assertNoConflictingCampaign(fresh._id);

    const now = new Date();
    let status = 'scheduled';
    if (payload.endsAt <= now) status = 'expired';
    else if (payload.startsAt <= now) {
      status = fresh.status === 'paused' ? 'paused' : 'active';
    }

    // Any price currently on products came from the old configuration.
    // Restore first so the new discount replaces it instead of stacking.
    await restoreCampaignProducts(fresh);

    Object.assign(fresh, payload, {
      status,
      appliedAt: status === 'active' ? now : null,
      lastRestoredAt: new Date(),
      appliedProductCount: 0,
    });
    await fresh.save();

    if (status === 'active') {
      const applied = await applyCampaignToProducts(fresh);
      fresh.appliedProductCount = applied.appliedCount;
      await fresh.save();
    }

    return res.status(200).json({
      success: true,
      message: 'Flash sale updated.',
      data: fresh,
    });
  } catch (error) {
    return sendError(res, error, 'Could not update the flash sale.');
  }
};

exports.deleteCampaign = async (req, res) => {
  try {
    const campaign = await FlashSale.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({success: false, message: 'Flash sale not found.'});
    }

    const restored = await restoreCampaignProducts(campaign);
    await FlashSale.findByIdAndDelete(campaign._id);

    return res.status(200).json({
      success: true,
      message: `Flash sale deleted. Prices restored on ${restored.restoredCount} product(s).`,
      data: {restoredCount: restored.restoredCount},
    });
  } catch (error) {
    return sendError(res, error, 'Could not delete the flash sale.');
  }
};

// One-click (bulk) application for products added after a campaign started,
// or for a sale that was created while products were temporarily unavailable.
exports.applyCampaign = async (req, res) => {
  try {
    await safeSync({force: true});
    const campaign = await FlashSale.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({success: false, message: 'Flash sale not found.'});
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Only an active flash sale can have its discount applied.',
      });
    }

    const now = new Date();
    if (campaign.startsAt > now || campaign.endsAt <= now) {
      return res.status(400).json({
        success: false,
        message: 'The campaign is outside its configured start/end window.',
      });
    }

    const applied = await applyCampaignToProducts(campaign);
    campaign.appliedProductCount = applied.appliedCount;
    campaign.appliedAt = now;
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: `Discount applied to ${applied.appliedCount} eligible product(s).`,
      data: {
        matchedCount: applied.matchedCount,
        appliedCount: applied.appliedCount,
        campaign,
      },
    });
  } catch (error) {
    return sendError(res, error, 'Could not apply the flash sale discount.');
  }
};

exports.activateCampaign = async (req, res) => {
  try {
    await safeSync({force: true});
    const campaign = await FlashSale.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({success: false, message: 'Flash sale not found.'});
    }
    if (campaign.endsAt <= new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This flash sale has already expired. Edit its dates to run it again.',
      });
    }

    await assertNoConflictingCampaign(campaign._id);

    const now = new Date();
    const startsNow = campaign.startsAt <= now;
    campaign.status = startsNow ? 'active' : 'scheduled';
    await campaign.save();

    if (startsNow) {
      const applied = await applyCampaignToProducts(campaign);
      campaign.appliedProductCount = applied.appliedCount;
      campaign.appliedAt = now;
      await campaign.save();
    }

    return res.status(200).json({
      success: true,
      message: startsNow
        ? `Flash sale activated. Discount applied to ${campaign.appliedProductCount} product(s).`
        : 'Flash sale scheduled to activate at its start time.',
      data: campaign,
    });
  } catch (error) {
    return sendError(res, error, 'Could not activate the flash sale.');
  }
};

exports.deactivateCampaign = async (req, res) => {
  try {
    const campaign = await FlashSale.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({success: false, message: 'Flash sale not found.'});
    }

    const restored = await restoreCampaignProducts(campaign);
    campaign.status = 'paused';
    campaign.appliedProductCount = 0;
    campaign.appliedAt = null;
    campaign.lastRestoredAt = new Date();
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: `Flash sale deactivated. Prices restored on ${restored.restoredCount} product(s).`,
      data: campaign,
    });
  } catch (error) {
    return sendError(res, error, 'Could not deactivate the flash sale.');
  }
};
