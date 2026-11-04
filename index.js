process.env.UNDICI_WASM = '0';
const express = require("express");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
require("./db");

const app = express();
const PORT = process.env.PORT || 8000;

const cors = require("cors");

// Routers
const authRouter = require("./routes/authRoutes");
const productRouter = require("./routes/product.routes");
const CategoryRouter = require("./routes/categoryRoutes");
const bannerRouter = require("./routes/bannerRoutes");
const cartRouter = require("./routes/cartRoutes");
const testimonialRouter = require("./routes/testimonialRoutes");
const shopByBudgetRouter = require("./routes/shopByBudget.routes");
const ordersRouter = require("./routes/orders.routes");
const socialItemRouter = require("./routes/socialItem.routes");
const holidayModeRouter = require("./routes/holidayMode.routes");
const reviewRouter = require("./routes/reviewRoutes");
const couponRouter = require("./routes/couponRoutes");
const featureRouter = require("./routes/featureRoutes");
const emailMarketingRoutes = require('./routes/emailMarketingRoutes');
const messagingRouter = require('./routes/messagingRoutes');
const restockNotificationRouter = require('./routes/restockNotification.routes');
const visitorAnalyticsRouter = require('./routes/visitorAnalytics.routes');
const { startHolidayModeSchedulers } = require('./schedulers/holidayMode.scheduler');
const {
  startRestockNotificationWorker,
} = require('./workers/restockNotification.worker');

console.log(`Server starting on port ${PORT}...`);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const uploadsDir = path.join(__dirname, "uploads");
const uploadsVideoDir = path.join(uploadsDir, "video");
const uploadsProductsDir = path.join(uploadsDir, "products");

// Legacy: some videos were saved under uploads/products — serve from video URL too
app.use("/uploads/video", (req, res, next) => {
  const fileName = path.basename(req.path);
  if (!fileName) return next();

  const videoPath = path.join(uploadsVideoDir, fileName);
  const legacyProductsPath = path.join(uploadsProductsDir, fileName);

  if (fs.existsSync(videoPath)) {
    return res.sendFile(videoPath);
  }
  if (fs.existsSync(legacyProductsPath)) {
    return res.sendFile(legacyProductsPath);
  }
  return res.status(404).send("Video not found");
});

app.use("/uploads", express.static(uploadsDir, {
  maxAge: '30d',
  etag: true,
  lastModified: true,
  immutable: true,
}));

// Backward compatibility: keep old root-level asset links working.
app.get("/products/:file", (req, res) => {
  res.redirect(301, `/uploads/products/${req.params.file}`);
});

app.get("/video/:file", (req, res) => {
  res.redirect(301, `/uploads/video/${req.params.file}`);
});

app.get("/banners/:file", (req, res) => {
  res.redirect(301, `/uploads/banners/${req.params.file}`);
});

// // Serve uploaded files
// app.use("/uploads", express.static("uploads"));

// // API routes
app.use("/api", authRouter);
app.use("/api", productRouter);
app.use("/api", CategoryRouter);
app.use("/api", bannerRouter);
app.use("/api", cartRouter);
app.use("/api", testimonialRouter);
app.use("/api", shopByBudgetRouter);
app.use("/api", ordersRouter);
app.use("/api", socialItemRouter);
app.use("/api", holidayModeRouter);
app.use("/api", reviewRouter);
app.use("/api", couponRouter);
app.use("/api", featureRouter);
app.use('/api/email', emailMarketingRoutes);

app.use('/api', messagingRouter);
app.use('/api', restockNotificationRouter);
app.use('/api', visitorAnalyticsRouter);

app.use('/api/scan', require('./routes/scanRoutes'));

console.log("Backend server running...");

// Show which invoice-PDF tiers are usable on this host, so a deploy that
// skipped `npm install` (pdfkit missing) or has no Chrome is visible in the
// boot log rather than as a customer email with no attachment.
try {
  const { describeInvoiceRenderers } = require('./services/invoiceRenderer.service');
  console.log(`[invoice] PDF renderers: ${describeInvoiceRenderers()}`);
} catch (err) {
  console.error('[invoice] could not probe PDF renderers:', err.message);
}




// // Root endpoint (optional)
// app.get("/", (req, res) => {
//   res.send("Backend API is running...");
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`Server initialized successfully on port ${PORT}`);
// });




// Serve frontend build
app.use(express.static(path.join(__dirname, "frontend/dist")));

// Any other route not handled by API will serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/dist", "index.html"));
});
app.listen(PORT, () => {
  console.log(`Server initialized successfully on port ${PORT}`);
  startHolidayModeSchedulers();
  // Safety net for pending back-in-stock alerts (missed trigger, crash, SMTP
  // hiccup). The immediate notification on a stock update still runs first.
  startRestockNotificationWorker();
});


// Serve static files from uploads folder
// app.use("/uploads", express.static(path.join(__dirname, "uploads")));