const express = require('express');
const {authenticate, requireAdmin} = require('../auth');
const {
  getActiveFlashSale,
  getAllCampaignsAdmin,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  applyCampaign,
  activateCampaign,
  deactivateCampaign,
} = require('../controllers/flashSale.controller');

const router = express.Router();

// Public — homepage countdown and deal grid.
router.get('/flash-sale/active', getActiveFlashSale);

// Admin management. authenticate must run first — requireAdmin reads req.user.
router.get('/flash-sale/admin/all', authenticate, requireAdmin, getAllCampaignsAdmin);
router.post('/flash-sale/admin/create', authenticate, requireAdmin, createCampaign);
router.put('/flash-sale/admin/:id', authenticate, requireAdmin, updateCampaign);
router.delete('/flash-sale/admin/:id', authenticate, requireAdmin, deleteCampaign);
router.post('/flash-sale/admin/:id/apply', authenticate, requireAdmin, applyCampaign);
router.post('/flash-sale/admin/:id/activate', authenticate, requireAdmin, activateCampaign);
router.post('/flash-sale/admin/:id/deactivate', authenticate, requireAdmin, deactivateCampaign);

module.exports = router;
