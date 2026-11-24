const express = require('express')
const multer = require('multer')
const { authenticate, requireAdmin } = require('../auth')
const { config } = require('../config/visualSearch.config')
const { visualSearchRateLimit } = require('../middlewares/visualSearchRateLimit')
const controller = require('../controllers/visualSearch.controller')

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxBytes,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (config.upload.allowedMimeTypes.includes(file.mimetype)) return cb(null, true)
    const error = new Error('Only JPG, JPEG, PNG, and WEBP images are supported.')
    error.code = 'INVALID_MIME'
    return cb(error)
  },
})

const singleImage = (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: `Images must be smaller than ${Math.round(config.upload.maxBytes / (1024 * 1024))} MB.`,
        code: 'IMAGE_TOO_LARGE',
      })
    }
    if (error.code === 'INVALID_MIME' || error instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message: 'Only JPG, JPEG, PNG, and WEBP images are supported.',
        code: 'INVALID_IMAGE',
      })
    }
    return res.status(400).json({ success: false, message: error.message, code: 'INVALID_IMAGE' })
  })
}

/* =========================
   PUBLIC / CUSTOMER ROUTES
   ========================= */
router.get('/visual-search/status', controller.getStatus)
router.post('/visual-search', visualSearchRateLimit, singleImage, controller.visualSearch)

/* =========================
   ADMIN INDEXING ROUTES
   ========================= */
router.get('/admin/visual-search/status', authenticate, requireAdmin, controller.getAdminStatus)
router.post('/admin/visual-search/index', authenticate, requireAdmin, controller.startIndexing)
router.post('/admin/visual-search/pause', authenticate, requireAdmin, controller.pauseIndexing)
router.post('/admin/visual-search/resume', authenticate, requireAdmin, controller.resumeIndexing)
router.post('/admin/visual-search/cancel', authenticate, requireAdmin, controller.cancelIndexing)
router.post('/admin/visual-search/reindex', authenticate, requireAdmin, controller.startIndexing)
router.post('/admin/visual-search/reindex/:productId', authenticate, requireAdmin, controller.reindexProduct)
router.delete('/admin/visual-search/index/:productId', authenticate, requireAdmin, controller.deleteProductEmbeddings)
router.get('/admin/visual-search/failures', authenticate, requireAdmin, controller.getFailures)

module.exports = router
