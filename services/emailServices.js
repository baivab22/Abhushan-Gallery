require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const {
  EMAIL_CONFIG,
  transporter,
  buildCommonHeaders,
  getPublicSiteUrl,
} = require('./mailConfig');
const { buildEmailShell, getLogoAttachment } = require('./emailTemplate');
const { Product } = require("../modals/product.modal");
const {
  generateInvoicePdfBuffer,
  generateInvoiceNativePdfBuffer,
  generateInvoiceBarePdfBuffer,
} = require('./invoiceRenderer.service');

const formatCurrency = (value) => `NPR ${Number(value || 0).toFixed(2)}`;

/**
 * Build the invoice attachment for an order email.
 *
 * Always a PDF, in three tiers:
 *   1. Chromium-rendered (puppeteer) — the full A4 layout with pagination.
 *   2. Native (pdfkit) — used when no Chrome binary is available. It draws the
 *      same invoice as real PDF text, so the characters are always correct.
 *   3. Bare (zero dependencies) — writes the PDF by hand with Node built-ins,
 *      for hosts where pdfkit is missing from node_modules as well.
 *
 * The old PNG raster fallback is gone on purpose: on hosts without Chromium it
 * produced an image whose glyphs were missing/garbled, and an image is not a
 * document the customer can print or keep. Returns null (send without an
 * attachment) only if every PDF path fails — each tier logs why it bailed.
 */
const buildInvoiceAttachment = async ({ order, customerEmail, customerName, senderEmail, title }) => {
  let orderId = 'ORDER';
  try {
    orderId = order?.productOrderId || String(order?._id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase() || 'ORDER';
  } catch {
    // a malformed id must never abort the email itself
  }
  const rendererParams = { order, customerEmail, customerName, senderEmail, title };

  try {
    const pdf = await generateInvoicePdfBuffer(rendererParams);
    if (pdf) {
      const buffer = Buffer.from(pdf);
      console.log(`[invoice] PDF generated (Chromium): ${buffer.length} bytes`);
      return { filename: `invoice-${orderId}.pdf`, content: buffer, contentType: 'application/pdf' };
    }
  } catch (error) {
    console.error(`[invoice] Chromium PDF generation failed for ${orderId}:`, error?.message);
  }

  try {
    const pdf = await generateInvoiceNativePdfBuffer(rendererParams);
    if (pdf) {
      const buffer = Buffer.from(pdf);
      console.log(`[invoice] PDF generated (native fallback): ${buffer.length} bytes`);
      return { filename: `invoice-${orderId}.pdf`, content: buffer, contentType: 'application/pdf' };
    }
  } catch (error) {
    console.error(`[invoice] native PDF generation failed for ${orderId}:`, error?.message);
  }

  try {
    const pdf = await generateInvoiceBarePdfBuffer(rendererParams);
    if (pdf) {
      const buffer = Buffer.from(pdf);
      console.log(`[invoice] PDF generated (bare fallback): ${buffer.length} bytes`);
      return { filename: `invoice-${orderId}.pdf`, content: buffer, contentType: 'application/pdf' };
    }
  } catch (error) {
    console.error(`[invoice] bare PDF generation failed for ${orderId}:`, error?.message);
  }

  console.error(`[invoice] Could not render a PDF invoice for ${orderId}; sending without an attachment.`);
  return null;
};

const buildFooterHtml = () => `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;line-height:1.6;">
    <p style="margin:0;">Abhushan Gallery | Kalimati, Kathmandu, Nepal</p>
    <p style="margin:4px 0 0;">Phone: 9861698400 | Email: ${EMAIL_CONFIG.sender}</p>
    <p style="margin:8px 0 0;">&copy; ${new Date().getFullYear()} Abhushan Gallery. All rights reserved.</p>
  </div>
`;

const buildFooterText = () => `
---
Abhushan Gallery | Kalimati, Kathmandu, Nepal
Phone: 9861698400 | Email: ${EMAIL_CONFIG.sender}
(c) ${new Date().getFullYear()} Abhushan Gallery. All rights reserved.
`;

const sendOutOfStockNotification = async (newOutOfStockProducts) => {
  try {
    const allOutOfStockProducts = await Product.find({
      stockQuantity: 0
    }).populate('category').populate('subCategory');

    console.log('allout of stock products:', allOutOfStockProducts);

    const subject = `Product Out of Stock Alert - ${newOutOfStockProducts.length} New Product(s) Out of Stock`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
        <div style="padding:28px 12px;">
          <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
            <div style="padding:24px 22px 16px;background:linear-gradient(135deg,#fef2f2 0%,#fff1f2 100%);text-align:center;border-bottom:1px solid #fecaca;">
              <h1 style="margin:0;font-size:22px;color:#991b1b;">Product Out of Stock Alert</h1>
              <p style="margin:6px 0 0;font-size:14px;color:#6b7280;">Dear Admin,</p>
            </div>
            <div style="padding:24px 22px;">
              <div style="margin-bottom:24px;">
                <h2 style="margin:0 0 12px;font-size:18px;color:#991b1b;border-bottom:2px solid #fecaca;padding-bottom:8px;">
                  Newly Out of Stock (${newOutOfStockProducts.length})
                </h2>
                <div style="background-color:#fef2f2;padding:16px;border-radius:8px;border-left:4px solid #dc2626;">
                  ${newOutOfStockProducts.map(product => `
                    <div style="padding:12px;border-bottom:1px solid #fecdd3;margin-bottom:10px;">
                      <h3 style="margin:0 0 6px;color:#991b1b;font-size:16px;">${product.name}</h3>
                      <p style="margin:2px 0;font-size:13px;"><strong>Previous Stock:</strong> ${product.previousStock} units</p>
                      <p style="margin:2px 0;font-size:13px;"><strong>Ordered Quantity:</strong> ${product.orderedQuantity} units</p>
                      <p style="margin:2px 0;font-size:13px;"><strong>Price:</strong> NPR ${product.discountedPrice || 'N/A'}</p>
                      <p style="margin:2px 0;font-size:13px;"><strong> Prevously listed Time:</strong> ${new Date().toLocaleString()}</p>
                    </div>
                  `).join('')}
                </div>
              </div>

              <div style="margin-bottom:24px;">
                <h2 style="margin:0 0 12px;font-size:18px;color:#c2410c;border-bottom:2px solid #fed7aa;padding-bottom:8px;">
                  Complete Out of Stock Inventory (${allOutOfStockProducts.length})
                </h2>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                  <thead>
                    <tr style="background:#fff7ed;">
                      <th style="padding:10px;text-align:left;border-bottom:2px solid #fed7aa;">Product</th>
                      <th style="padding:10px;text-align:left;border-bottom:2px solid #fed7aa;">Category</th>
                      <th style="padding:10px;text-align:center;border-bottom:2px solid #fed7aa;">Sales</th>
                      <th style="padding:10px;text-align:left;border-bottom:2px solid #fed7aa;">Last Sold</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${allOutOfStockProducts.map(p => `
                      <tr style="border-bottom:1px solid #fed7aa;">
                        <td style="padding:10px;font-weight:600;">${p.name}</td>
                        <td style="padding:10px;">${p.category?.name || 'N/A'}</td>
                        <td style="padding:10px;text-align:center;">${p.totalSales || 0}</td>
                        <td style="padding:10px;">${p.lastSoldAt ? new Date(p.lastSoldAt).toLocaleDateString() : 'Never'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
                ${allOutOfStockProducts.length === 0 ? '<p style="text-align:center;color:#16a34a;padding:20px;font-weight:600;">All products are in stock.</p>' : ''}
              </div>

              <div style="background:#f0fdf4;padding:16px;border-radius:8px;border-left:4px solid #22c55e;margin-bottom:16px;">
                <h3 style="margin:0 0 8px;color:#166534;font-size:15px;">Summary</h3>
                <p style="margin:2px 0;font-size:13px;"><strong>New Out of Stock:</strong> ${newOutOfStockProducts.length} product(s)</p>
                <p style="margin:2px 0;font-size:13px;"><strong>Total Out of Stock:</strong> ${allOutOfStockProducts.length} product(s)</p>
                <p style="margin:2px 0;font-size:13px;"><strong>Time:</strong> ${new Date().toLocaleString()}</p>
              </div>

              <p style="font-size:14px;line-height:1.6;color:#374151;">Please review and restock these products to avoid lost sales.</p>
            </div>
            ${buildFooterHtml()}
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `Product Out of Stock Alert

Dear Admin,

Newly Out of Stock (${newOutOfStockProducts.length}):
${newOutOfStockProducts.map(p => `- ${p.name}: ${p.previousStock} units -> 0 (ordered ${p.orderedQuantity})`).join('\n')}

Total Out of Stock: ${allOutOfStockProducts.length} products
Time: ${new Date().toLocaleString()}

Please restock these products.
${buildFooterText()}`;

    const { messageId, date, customHeaders } = buildCommonHeaders({ to: EMAIL_CONFIG.adminRecipients, subject });

    await transporter.sendMail({
      from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
      to: EMAIL_CONFIG.adminRecipients,
      subject,
      html,
      text,
      messageId,
      date,
      headers: customHeaders,
      replyTo: EMAIL_CONFIG.sender,
    });
    console.log(`Out-of-stock notification sent for ${newOutOfStockProducts.length} new products. Total out of stock: ${allOutOfStockProducts.length}`);

    return true;
  } catch (error) {
    console.error('Error sending out-of-stock notification:', error);
    return false;
  }
};

const sendCompleteOutOfStockReport = async () => {
  try {
    const allOutOfStockProducts = await Product.find({
      stockQuantity: 0
    })
    .populate('category')
    .populate('subCategory')
    .sort({ totalSales: -1, lastSoldAt: -1 });

    const subject = `Complete Out of Stock Report - ${allOutOfStockProducts.length} Products`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
        <div style="padding:28px 12px;">
          <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
            <div style="padding:24px 22px 16px;background:linear-gradient(135deg,#fff7ed 0%,#fef3c7 100%);text-align:center;border-bottom:1px solid #fed7aa;">
              <h1 style="margin:0;font-size:22px;color:#c2410c;">Out of Stock Inventory Report</h1>
              <p style="margin:6px 0 0;font-size:14px;color:#6b7280;">Dear Admin,</p>
            </div>
            <div style="padding:24px 22px;">
              <p style="font-size:14px;line-height:1.6;color:#374151;">Here is the complete list of all products currently out of stock:</p>

              <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
                <thead>
                  <tr style="background:#fff7ed;">
                    <th style="padding:10px;text-align:left;border-bottom:2px solid #fed7aa;">Product</th>
                    <th style="padding:10px;text-align:left;border-bottom:2px solid #fed7aa;">Category</th>
                    <th style="padding:10px;text-align:center;border-bottom:2px solid #fed7aa;">Sales</th>
                    <th style="padding:10px;text-align:left;border-bottom:2px solid #fed7aa;">Last Sold</th>
                  </tr>
                </thead>
                <tbody>
                  ${allOutOfStockProducts.map((p, i) => `
                    <tr style="${i % 2 === 0 ? 'background:#fffbeb;' : 'background:#fff;'}border-bottom:1px solid #fed7aa;">
                      <td style="padding:10px;font-weight:600;">${p.name}</td>
                      <td style="padding:10px;">${p.category?.name || 'N/A'}</td>
                      <td style="padding:10px;text-align:center;">${p.totalSales || 0}</td>
                      <td style="padding:10px;">${p.lastSoldAt ? new Date(p.lastSoldAt).toLocaleDateString() : 'Never'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
              ${allOutOfStockProducts.length === 0 ? '<p style="text-align:center;color:#16a34a;padding:20px;font-weight:600;">All products are in stock.</p>' : ''}

              <div style="background:#eff6ff;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;margin:16px 0;">
                <h3 style="margin:0 0 8px;color:#1e40af;font-size:15px;">Summary</h3>
                <p style="margin:2px 0;font-size:13px;"><strong>Total Out of Stock:</strong> ${allOutOfStockProducts.length}</p>
                <p style="margin:2px 0;font-size:13px;"><strong>High Sales (50+):</strong> ${allOutOfStockProducts.filter(p => p.totalSales >= 50).length}</p>
                <p style="margin:2px 0;font-size:13px;"><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
              </div>
            </div>
            ${buildFooterHtml()}
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `Out of Stock Inventory Report

Total Out of Stock: ${allOutOfStockProducts.length} products
${allOutOfStockProducts.map((p, i) => `${i + 1}. ${p.name} (${p.category?.name || 'N/A'}) - Sales: ${p.totalSales || 0}`).join('\n')}

Generated: ${new Date().toLocaleString()}
${buildFooterText()}`;

    const { messageId, date, customHeaders } = buildCommonHeaders({ to: EMAIL_CONFIG.adminRecipients, subject });

    await transporter.sendMail({
      from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
      to: EMAIL_CONFIG.adminRecipients,
      subject,
      html,
      text,
      messageId,
      date,
      headers: customHeaders,
      replyTo: EMAIL_CONFIG.sender,
    });
    console.log(`Complete out-of-stock report sent. Total out of stock: ${allOutOfStockProducts.length}`);

    return true;
  } catch (error) {
    console.error('Error sending complete out-of-stock report:', error);
    return false;
  }
};

const sendNewOrderPlacedNotification = async (order) => {
  try {
    const adminRecipient = EMAIL_CONFIG.adminRecipients;

    if (!adminRecipient || (Array.isArray(adminRecipient) && adminRecipient.length === 0)) {
      console.error('ADMIN_EMAIL is not configured. Cannot send order notification.');
      return false;
    }

    const orderId = order?.productOrderId || order?._id || "N/A";
    const orderedAt = order?.OrderedAt || new Date().toLocaleString();
    const paymentMethod = order?.paymentMethod || "N/A";
    const shippingLocation = order?.shippingLocation || order?.locationAddress || "N/A";
    const phoneNumber = order?.phoneNumber || "N/A";
    const totalAmount = Number(order?.totalAmount || 0);
    const shippingPrice = Number(order?.shippingPrice || 0);
    const giftBoxCharge = Number(order?.giftBoxCharge || 0);

    // order.name is what the customer typed in the checkout form. The account
    // name and the legacy guest fullName only fill in for older orders.
    const userName = order?.name || order?.userId?.name || order?.fullName || "N/A";
    const userEmail = order?.userId?.email || "N/A";
    const userPhone = order?.userId?.phone || phoneNumber || "N/A";
    const userId = typeof order?.userId === "object" ? order?.userId?._id : order?.userId;

    const deliveryType = order?.isHomeDelivery ? "Home Delivery" : "Store Pickup";
    const deliveryZone = order?.isInsideValley ? "Inside Valley" : "Outside Valley";
    const deliveryArea = order?.isRedZone ? "Red Zone" : "Standard Zone";
    const deliveryPartner = order?.deliveryPartner || "To be assigned";
    const deliveryTime = order?.deliveryTimeMessage || "To be confirmed";

    let subtotal = 0;
    const productsHtml = (order?.products || [])
      .map((item, index) => {
        const productId = item?.productId?._id || item?.productId || "N/A";
        const productName = item?.productId?.name || "Product";
        const colorName = item?.colorName || "-";
        const quantity = Number(item?.quantity || 0);
        const linePrice = Number(item?.price || 0);
        subtotal += linePrice;
        const unitPrice = quantity > 0 ? linePrice / quantity : linePrice;
        return `
          <tr>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${index + 1}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;">
              <div style="font-weight:600;color:#111827;">${productName}</div>
            </td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">${colorName}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">${quantity}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatCurrency(unitPrice)}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">${formatCurrency(linePrice)}</td>
          </tr>
        `;
      })
      .join("");

    const subject = `New Order Placed - ${orderId}`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f3f4f6;font-family:'DM Sans',Arial,Helvetica,sans-serif;color:#111827;">
        <div style="padding:28px 12px;">
          <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
            <div style="padding:28px 24px 18px;background:#111827;text-align:center;">
              <h1 style="margin:0;font-size:24px;color:#ffffff;font-weight:700;letter-spacing:0.5px;">New Order Notification</h1>
              <p style="margin:8px 0 0;font-size:14px;color:#9ca3af;">A new order has been placed successfully</p>
            </div>
            <div style="padding:24px 22px;">

              <!-- Order Overview -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:20px;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Order Details</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <p style="margin:4px 0;font-size:14px;"><strong>Order ID:</strong> <span style="font-family:monospace;color:#2563eb;font-weight:700;">${orderId}</span></p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Ordered At:</strong> ${orderedAt}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Payment:</strong> ${paymentMethod}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Grand Total:</strong> <span style="color:#166534;font-weight:700;font-size:15px;">${formatCurrency(totalAmount)}</span></p>
                </div>
              </div>

              <!-- Customer Info -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:20px;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Customer Information</h3>
                <p style="margin:4px 0;font-size:14px;"><strong>Name:</strong> ${escapeHtml(userName)}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Email:</strong> ${userEmail}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Phone:</strong> ${userPhone}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>User ID:</strong> <span style="font-family:monospace;font-size:12px;color:#6b7280;">${userId || 'N/A'}</span></p>
              </div>

              <!-- Delivery Info -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:20px;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Delivery Information</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <p style="margin:4px 0;font-size:14px;"><strong>Type:</strong> ${deliveryType}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Zone:</strong> ${deliveryZone}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Area:</strong> ${deliveryArea}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Partner:</strong> ${deliveryPartner}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Est. Delivery:</strong> ${deliveryTime}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Ship To:</strong> ${shippingLocation}</p>
                </div>
              </div>

              <!-- Products -->
              <h2 style="margin:0 0 10px;font-size:16px;color:#374151;">Ordered Products</h2>
              <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#111827;">
                    <th style="padding:10px;text-align:left;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">#</th>
                    <th style="padding:10px;text-align:left;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Product</th>
                    <th style="padding:10px;text-align:center;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Color</th>
                    <th style="padding:10px;text-align:center;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Qty</th>
                    <th style="padding:10px;text-align:right;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Unit Price</th>
                    <th style="padding:10px;text-align:right;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${productsHtml || "<tr><td colspan='6' style='padding:10px;text-align:center;color:#6b7280;'>No product lines</td></tr>"}
                </tbody>
              </table>

              <!-- Summary -->
              <div style="margin-top:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;">
                <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Subtotal</span><span style="font-weight:600;color:#374151;">${formatCurrency(subtotal)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Shipping</span><span style="font-weight:600;color:#374151;">${formatCurrency(shippingPrice)}</span>
                </div>
                ${giftBoxCharge > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Gift Box</span><span style="font-weight:600;color:#374151;">${formatCurrency(giftBoxCharge)}</span>
                </div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:6px;border-top:2px solid #111827;font-size:17px;">
                  <span style="font-weight:700;color:#111827;">Grand Total</span>
                  <span style="font-weight:800;color:#166534;">${formatCurrency(totalAmount)}</span>
                </div>
              </div>

              ${order?.orderNote ? `
              <!-- Order Note -->
              <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;margin-top:16px;">
                <h4 style="margin:0 0 6px;font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Order Note</h4>
                <p style="margin:0;font-size:13px;color:#78350f;line-height:1.5;">${order.orderNote}</p>
              </div>
              ` : ''}
            </div>
            ${buildFooterHtml()}
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `New Order Placed - ${orderId}

ORDER DETAILS
Order ID: ${orderId}
Ordered At: ${orderedAt}
Payment: ${paymentMethod}
Grand Total: ${formatCurrency(totalAmount)}

CUSTOMER INFORMATION
Name: ${userName}
Email: ${userEmail}
Phone: ${userPhone}
User ID: ${userId || 'N/A'}

DELIVERY INFORMATION
Type: ${deliveryType}
Zone: ${deliveryZone}
Area: ${deliveryArea}
Partner: ${deliveryPartner}
Est. Delivery: ${deliveryTime}
Ship To: ${shippingLocation}

PRODUCTS:
${(order?.products || []).map((item, i) => `${i + 1}. ${item?.productId?.name || 'Product'} (${item?.colorName || '-'}) x${item?.quantity || 0} - ${formatCurrency(item?.price || 0)}`).join('\n')}

Subtotal: ${formatCurrency(subtotal)}
Shipping: ${formatCurrency(shippingPrice)}
${giftBoxCharge > 0 ? `Gift Box: ${formatCurrency(giftBoxCharge)}\n` : ''}Grand Total: ${formatCurrency(totalAmount)}
${order?.orderNote ? `\nOrder Note: ${order.orderNote}\n` : ''}
${buildFooterText()}`;

    const { messageId, date, customHeaders } = buildCommonHeaders({ to: adminRecipient, subject });

    const info = await transporter.sendMail({
      from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
      to: adminRecipient,
      subject,
      html,
      text,
      messageId,
      date,
      headers: customHeaders,
      replyTo: EMAIL_CONFIG.sender,
    });
    console.log('Admin notification email sent. Message ID:', info?.messageId, 'Recipients:', adminRecipient);
    return true;
  } catch (error) {
    console.error("Error sending new order notification email:", error?.message || error);
    console.error("SMTP Error details:", error?.code, error?.command);
    return false;
  }
};

const sendOrderConfirmationToCustomer = async (order) => {
  try {
    const customerEmail = order?.userId?.email || order?.email;
    if (!customerEmail) {
      return false;
    }

    // order.name is captured at checkout and wins over the account name so the
    // greeting matches the name the customer actually typed for this order.
    const customerName = order?.name || order?.userId?.name || order?.fullName || 'Valued Customer';
    const orderId = order?.productOrderId || order?._id || 'N/A';

    const totalAmount = Number(order?.totalAmount || 0);
    const shippingLocation = order?.shippingLocation || order?.locationAddress || 'N/A';
    const paymentMethod = order?.paymentMethod || 'N/A';
    const shippingPrice = Number(order?.shippingPrice || 0);
    const giftBoxCharge = Number(order?.giftBoxCharge || 0);
    const deliveryPartner = order?.deliveryPartner || 'Not assigned yet';
    const deliveryType = order?.isHomeDelivery ? 'Home Delivery' : 'Store Pickup';
    const deliveryZone = order?.isInsideValley ? 'Inside Valley' : 'Outside Valley';
    const deliveryArea = order?.isRedZone ? 'Red Zone' : 'Standard Zone';
    const deliveryTime = order?.deliveryTimeMessage || 'To be confirmed';

    let subtotal = 0;
    const productsHtml = (order?.products || [])
      .map((item, index) => {
        const productName = item?.productId?.name || 'Product';
        const colorName = item?.colorName || '-';
        const quantity = Number(item?.quantity || 0);
        const linePrice = Number(item?.price || 0);
        subtotal += linePrice;
        return `
          <tr>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${index + 1}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;font-weight:600;">${productName}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">${colorName}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">${quantity}</td>
            <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatCurrency(linePrice)}</td>
          </tr>
        `;
      })
      .join('');

    const subject = `Order Confirmed - ${orderId}`;

    // A4 PDF invoice; falls back to the browser-free PDF renderer when
    // Chromium is unavailable. Either way the attachment is a PDF.
    const invoiceAttachment = await buildInvoiceAttachment({
      order,
      customerEmail,
      customerName,
      senderEmail: EMAIL_CONFIG.sender,
      title: 'Order Confirmation',
    });

    // Include attachment note only when the invoice was actually generated
    const invoiceNoteHtml = invoiceAttachment
      ? '<p style="font-size:14px;line-height:1.6;margin:16px 0;">We have attached your order invoice to this email for your records.</p>'
      : '';
    const invoiceNoteText = invoiceAttachment
      ? 'We have attached your order invoice to this email for your records.\n'
      : '';

    const attachment = invoiceAttachment ? [invoiceAttachment] : [];

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f3f4f6;font-family:'DM Sans',Arial,Helvetica,sans-serif;color:#111827;">
        <div style="padding:28px 12px;">
          <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
            <div style="padding:28px 24px 18px;background:#111827;text-align:center;">
              <h1 style="margin:0;font-size:24px;color:#ffffff;font-weight:700;">Order Confirmed</h1>
              <p style="margin:8px 0 0;font-size:14px;color:#9ca3af;">Your order has been confirmed and is being prepared</p>
            </div>
            <div style="padding:24px 22px;">
              <p style="font-size:14px;line-height:1.6;margin:0 0 12px;">Dear ${escapeHtml(customerName)},</p>
              <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">
                Your order has been confirmed by our team and is now being prepared for delivery.
              </p>

              <!-- Order Overview -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:16px 0;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Order Details</h3>
                <p style="margin:4px 0;font-size:14px;"><strong>Order ID:</strong> <span style="font-family:monospace;color:#2563eb;font-weight:700;">${orderId}</span></p>
                <p style="margin:4px 0;font-size:14px;"><strong>Name:</strong> ${escapeHtml(customerName)}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Payment:</strong> ${paymentMethod}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Shipping Address:</strong> ${shippingLocation}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Grand Total:</strong> <span style="color:#166534;font-weight:700;font-size:16px;">${formatCurrency(totalAmount)}</span></p>
              </div>

              <!-- Delivery Info -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:16px 0;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Delivery Information</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                  <p style="margin:4px 0;font-size:14px;"><strong>Type:</strong> ${deliveryType}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Zone:</strong> ${deliveryZone} · ${deliveryArea}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Partner:</strong> ${deliveryPartner}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Est. Delivery:</strong> ${deliveryTime}</p>
                </div>
              </div>

              <!-- Products -->
              <h2 style="margin:16px 0 8px;font-size:16px;color:#374151;">Order Items</h2>
              <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#111827;">
                    <th style="padding:10px;text-align:left;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">#</th>
                    <th style="padding:10px;text-align:left;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Product</th>
                    <th style="padding:10px;text-align:center;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Color</th>
                    <th style="padding:10px;text-align:center;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Qty</th>
                    <th style="padding:10px;text-align:right;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${productsHtml}
                </tbody>
              </table>

              <!-- Summary -->
              <div style="margin-top:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;">
                <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span><pre>Subtotal: </pre></span> <span style="font-weight:600;color:#374151;">${formatCurrency(subtotal)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span><pre>Shipping: </pre></span><span style="font-weight:600;color:#374151;">${formatCurrency(shippingPrice)}</span>
                </div>
                ${giftBoxCharge > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Gift Box</span><span style="font-weight:600;color:#374151;">${formatCurrency(giftBoxCharge)}</span>
                </div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:6px;border-top:2px solid #111827;font-size:17px;">
                  <span style="font-weight:700;color:#111827;">Grand Total</span>
                  <span style="font-weight:800;color:#166534;">${formatCurrency(totalAmount)}</span>
                </div>
              </div>

              ${invoiceNoteHtml}
              <p style="font-size:14px;line-height:1.6;margin:16px 0;">
                If you need any help, please contact us at ${EMAIL_CONFIG.sender}.
              </p>
              <p style="font-size:14px;line-height:1.6;margin:18px 0 0;">Thank you for shopping with Abhushan Gallery.</p>
            </div>
            ${buildFooterHtml()}
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `Order Confirmed - ${orderId}

Dear ${customerName},

Your order has been confirmed by our team and is now being prepared for delivery.

ORDER DETAILS
Order ID: ${orderId}
Name: ${customerName}
Payment: ${paymentMethod}
Shipping Address: ${shippingLocation}
Grand Total: ${formatCurrency(totalAmount)}

DELIVERY INFORMATION
Type: ${deliveryType}
Zone: ${deliveryZone} · ${deliveryArea}
Partner: ${deliveryPartner}
Est. Delivery: ${deliveryTime}

ORDER ITEMS:
${(order?.products || []).map((item, i) => `${i + 1}. ${item?.productId?.name || 'Product'} (${item?.colorName || '-'}) x${item?.quantity || 0} - ${formatCurrency(item?.price || 0)}`).join('\n')}

Subtotal: ${formatCurrency(subtotal)}
Shipping: ${formatCurrency(shippingPrice)}
${giftBoxCharge > 0 ? `Gift Box: ${formatCurrency(giftBoxCharge)}\n` : ''}Grand Total: ${formatCurrency(totalAmount)}

${invoiceNoteText}If you need help, contact us at ${EMAIL_CONFIG.sender}.

Thank you for shopping with Abhushan Gallery.
${buildFooterText()}`;

    const { messageId, date, customHeaders } = buildCommonHeaders({ to: customerEmail, subject });

    await transporter.sendMail({
      from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
      to: customerEmail,
      subject,
      html,
      text,
      messageId,
      date,
      headers: customHeaders,
      attachments: attachment,
      replyTo: EMAIL_CONFIG.sender,
    });

    console.log('Order confirmation email sent to customer:', customerEmail, 'for order:', orderId, invoiceAttachment ? `(with invoice: ${invoiceAttachment.filename})` : '(without invoice)');
    return true;
  } catch (error) {
    console.error('Error sending order confirmation email:', error?.message || error);
    return false;
  }
};

const sendOrderPlacedConfirmationToCustomer = async (order) => {
  try {
    const customerEmail = order?.userId?.email || order?.email;
    if (!customerEmail) {
      console.log('No customer email found, skipping order placed confirmation');
      return false;
    }

    // order.name is captured at checkout and wins over the account name so the
    // greeting matches the name the customer actually typed for this order.
    const customerName = order?.name || order?.userId?.name || order?.fullName || 'Valued Customer';
    const orderId = order?.productOrderId || order?._id || 'N/A';
    const totalAmount = Number(order?.totalAmount || 0);
    const shippingLocation = order?.shippingLocation || order?.locationAddress || 'N/A';
    const paymentMethod = order?.paymentMethod || 'N/A';
    const shippingPrice = Number(order?.shippingPrice || 0);
    const giftBoxCharge = Number(order?.giftBoxCharge || 0);

    let subtotal = 0;
    const productsHtml = (order?.products || [])
      .map((item, index) => {
        const productName = item?.productId?.name || 'Product';
        const colorName = item?.colorName || '-';
        const quantity = Number(item?.quantity || 0);
        const linePrice = Number(item?.price || 0);
        subtotal += linePrice;
        return `
          <tr>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${index + 1}</td>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:600;">${productName}</td>
            // <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${colorName}</td>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${quantity}</td>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatCurrency(linePrice)}</td>
          </tr>
        `;
      })
      .join('');

    const subject = `Order Received - ${orderId}`;

    // A4 PDF invoice; falls back to the browser-free PDF renderer when
    // Chromium is unavailable. Either way the attachment is a PDF.
    const invoiceAttachment = await buildInvoiceAttachment({
      order,
      customerEmail,
      customerName,
      senderEmail: EMAIL_CONFIG.sender,
      title: 'Order Invoice',
    });

    // Include attachment note only when the invoice was actually generated
    const invoiceNoteHtml = invoiceAttachment
      ? '<p style="font-size:14px;line-height:1.6;margin:16px 0;">We have attached your order invoice to this email for your records.</p>'
      : '';
    const invoiceNoteText = invoiceAttachment
      ? 'We have attached your order invoice to this email for your records.\n'
      : '';

    const attachment = invoiceAttachment ? [invoiceAttachment] : [];

    const deliveryType = order?.isHomeDelivery ? 'Home Delivery' : 'Store Pickup';
    const deliveryZone = order?.isInsideValley ? 'Inside Valley' : 'Outside Valley';
    const deliveryArea = order?.isRedZone ? 'Red Zone' : 'Standard Zone';
    const deliveryPartner = order?.deliveryPartner || 'To be assigned';
    const deliveryTime = order?.deliveryTimeMessage || 'To be confirmed';

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f3f4f6;font-family:'DM Sans',Arial,Helvetica,sans-serif;color:#111827;">
        <div style="padding:28px 12px;">
          <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
            <div style="padding:28px 24px 18px;background:#111827;text-align:center;">
              <h1 style="margin:0;font-size:24px;color:#ffffff;font-weight:700;">Order Received</h1>
              <p style="margin:8px 0 0;font-size:14px;color:#9ca3af;">Thank you for your order!</p>
            </div>
            <div style="padding:24px 22px;">
              <p style="font-size:14px;line-height:1.6;margin:0 0 12px;">Dear ${escapeHtml(customerName)},</p>
              <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">
                Thank you for your order! We have received your order and it is now being reviewed by our team.
                You will receive another confirmation email once your order is approved.
              </p>

              <!-- Order Overview -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:16px 0;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Order Details</h3>
                <p style="margin:4px 0;font-size:14px;"><strong>Order ID:</strong> <span style="font-family:monospace;color:#2563eb;font-weight:700;">${orderId}</span></p>
                <p style="margin:4px 0;font-size:14px;"><strong>Name:</strong> ${escapeHtml(customerName)}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Payment:</strong> ${paymentMethod}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Shipping Address:</strong> ${shippingLocation}</p>
                <p style="margin:4px 0;font-size:14px;"><strong>Grand Total:</strong> <span style="color:#166534;font-weight:700;font-size:16px;">${formatCurrency(totalAmount)}</span></p>
              </div>

              <!-- Delivery Info -->
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:16px 0;">
                <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Delivery Information</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                  <p style="margin:4px 0;font-size:14px;"><strong>Type:</strong> ${deliveryType}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Zone:</strong> ${deliveryZone} · ${deliveryArea}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Partner:</strong> ${deliveryPartner}</p>
                  <p style="margin:4px 0;font-size:14px;"><strong>Est. Delivery:</strong> ${deliveryTime}</p>
                </div>
              </div>

              <!-- Products -->
              <h2 style="margin:16px 0 8px;font-size:16px;color:#374151;">Order Summary</h2>
              <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#111827;">
                    <th style="padding:10px;text-align:left;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">#</th>
                    <th style="padding:10px;text-align:left;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Product</th>
                    <th style="padding:10px;text-align:center;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Color</th>
                    <th style="padding:10px;text-align:center;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Qty</th>
                    <th style="padding:10px;text-align:right;color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${productsHtml}
                </tbody>
              </table>

              <!-- Summary -->
              <div style="margin-top:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;">
                <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Subtotal</span><span style="font-weight:600;color:#374151;">${formatCurrency(subtotal)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Shipping</span><span style="font-weight:600;color:#374151;">${formatCurrency(shippingPrice)}</span>
                </div>
                ${giftBoxCharge > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#6b7280;">
                  <span>Gift Box</span><span style="font-weight:600;color:#374151;">${formatCurrency(giftBoxCharge)}</span>
                </div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:6px;border-top:2px solid #111827;font-size:17px;">
                  <span style="font-weight:700;color:#111827;">Grand Total</span>
                  <span style="font-weight:800;color:#166534;">${formatCurrency(totalAmount)}</span>
                </div>
              </div>

              ${invoiceNoteHtml}
              <p style="font-size:14px;line-height:1.6;margin:16px 0;">
                If you have any questions, please contact us at ${EMAIL_CONFIG.sender}.
              </p>
              <p style="font-size:14px;line-height:1.6;margin:18px 0 0;">Thank you for shopping with Abhushan Gallery.</p>
            </div>
            ${buildFooterHtml()}
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `Order Received - ${orderId}

Dear ${customerName},

Thank you for your order! We have received your order and it is now being reviewed.
You will receive another confirmation email once your order is approved.

ORDER DETAILS
Order ID: ${orderId}
Name: ${customerName}
Payment: ${paymentMethod}
Shipping Address: ${shippingLocation}
Grand Total: ${formatCurrency(totalAmount)}

DELIVERY INFORMATION
Type: ${deliveryType}
Zone: ${deliveryZone} · ${deliveryArea}
Partner: ${deliveryPartner}
Est. Delivery: ${deliveryTime}

ORDER SUMMARY:
${(order?.products || []).map((item, i) => `${i + 1}. ${item?.productId?.name || 'Product'} (${item?.colorName || '-'}) x${item?.quantity || 0} - ${formatCurrency(item?.price || 0)}`).join('\n')}

Subtotal: ${formatCurrency(subtotal)}
Shipping: ${formatCurrency(shippingPrice)}
${giftBoxCharge > 0 ? `Gift Box: ${formatCurrency(giftBoxCharge)}\n` : ''}Grand Total: ${formatCurrency(totalAmount)}

${invoiceNoteText}If you have any questions, contact us at ${EMAIL_CONFIG.sender}.

Thank you for shopping with Abhushan Gallery.
${buildFooterText()}`;

    const { messageId, date, customHeaders } = buildCommonHeaders({ to: customerEmail, subject });

    await transporter.sendMail({
      from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
      to: customerEmail,
      subject,
      html,
      text,
      messageId,
      date,
      headers: customHeaders,
      attachments: attachment,
      replyTo: EMAIL_CONFIG.sender,
    });

    console.log('Order placed confirmation email sent to:', customerEmail, 'for order:', orderId, invoiceAttachment ? `(with invoice: ${invoiceAttachment.filename})` : '(without invoice)');
    return true;
  } catch (error) {
    console.error('Error sending order placed confirmation email:', error?.message || error);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Restock ("back in stock") notification — sent to customers who tried to add
// an out-of-stock product to their cart and opted in to be notified.
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getPublicBaseUrl = () => getPublicSiteUrl();

const buildProductPageUrl = (productId) =>
  `${getPublicBaseUrl()}/#/products/view/${productId}`;

// Mirrors the client's resolveProductImageUrl() so emails render the same
// images the storefront does (files live under /uploads/products).
const buildProductImageUrl = (rawValue) => {
  if (!rawValue) return '';
  const value = String(rawValue).trim();
  if (/^https?:\/\//i.test(value)) return encodeURI(value);
  const cleaned = encodeURIComponent(value.replace(/^\/+/, ''));
  return `${getPublicBaseUrl()}/uploads/products/${cleaned}`;
};

const getProductDisplayPrice = (product) => {
  const price =
    product.discountedPrice ?? product.originalPrice ?? product.price ?? null;
  return price !== null ? formatCurrency(price) : null;
};

/**
 * Notify a single subscriber that a product they wanted is back in stock.
 * Throws on failure so callers (restockNotification.service) can retry later.
 */
const sendRestockAvailableEmail = async (recipientEmail, product) => {
  const productName = escapeHtml(product.name || 'A product you liked');
  const displayPrice = getProductDisplayPrice(product);
  // Support both the current `coloredImages` array and the legacy single
  // `coloredImage` field so older products still render an image in the email.
  const imageVariants = Array.isArray(product.images) ? product.images : [];
  const firstImage = imageVariants
    .flatMap((img) => {
      if (typeof img === "string") return [img];
      if (Array.isArray(img?.coloredImages)) return img.coloredImages;
      if (img?.coloredImage) return [img.coloredImage];
      return [];
    })
    .find(Boolean);
  const imageUrl = buildProductImageUrl(firstImage);
  const productId = product._id || product.id;
  if (!productId) {
    throw new Error('Cannot build restock email without a product id');
  }
  const productUrl = buildProductPageUrl(productId);

  const subject = `Back in stock: ${product.name || 'Your awaited item'}`;

  const imageHtml = imageUrl
    ? `<a href="${productUrl}" style="text-decoration:none;">
         <img src="${imageUrl}" alt="${productName}" width="220" style="width:220px;height:auto;border-radius:10px;border:1px solid #e5e7eb;display:block;margin:0 auto;" />
       </a>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 18px;font-size:14px;color:#374151;">Good news! The item you tried to order is <strong>back in stock</strong>.</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid #22c55e;border-radius:8px;padding:20px;text-align:center;">
      ${imageHtml}
      <h3 style="margin:14px 0 4px;font-size:17px;color:#111827;">${productName}</h3>
      ${displayPrice ? `<p style="margin:0;font-size:15px;color:#166534;font-weight:700;">${displayPrice}</p>` : ''}
      <p style="margin:6px 0 0;font-size:13px;color:#16a34a;font-weight:600;">Limited stock available</p>
    </div>
    <div style="text-align:center;margin-top:24px;">
      <a href="${productUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 32px;border-radius:999px;">
        Shop Now
      </a>
    </div>
    <p style="margin:22px 0 0;font-size:12px;color:#6b7280;text-align:center;">
      You received this email because you requested a restock alert for this item. This is a one-time notification.
    </p>
  `;

  const text = `Back in stock!

${product.name} is available again${displayPrice ? ` at ${displayPrice}` : ''}.
Quantities are limited - grab yours before it sells out.

Shop now: ${productUrl}

You received this one-time email because you requested a restock alert for this item.
${buildFooterText()}`;

  const { messageId, date, customHeaders } = buildCommonHeaders({
    to: recipientEmail,
    subject,
  });

  const info = await transporter.sendMail({
    from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
    to: recipientEmail,
    subject,
    html: buildEmailShell({
      subject,
      title: 'It\u2019s back in stock!',
      subtitle: 'The item you were waiting for is available again',
      bodyHtml,
    }),
    text,
    messageId,
    date,
    headers: customHeaders,
    attachments: getLogoAttachment(),
    replyTo: EMAIL_CONFIG.sender,
  });

  // Nodemailer resolves even when the SMTP server rejects the recipient. Treat
  // that as a failure so the worker can retry instead of marking it "sent".
  const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
  const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
  const normalizedRecipient = String(recipientEmail || '')
    .trim()
    .toLowerCase();
  const normalizeAddress = (value) =>
    String(value || '').trim().toLowerCase();
  const wasRejected =
    rejected.some((value) => normalizeAddress(value) === normalizedRecipient) ||
    (accepted.length > 0 &&
      !accepted.some(
        (value) => normalizeAddress(value) === normalizedRecipient
      ));
  if (wasRejected) {
    throw new Error(
      `SMTP rejected restock recipient ${recipientEmail}`
    );
  }

  console.log(`[Restock] Back-in-stock email sent to ${recipientEmail}`);
  return true;
};

module.exports = {
  sendOutOfStockNotification,
  sendCompleteOutOfStockReport,
  sendNewOrderPlacedNotification,
  sendOrderConfirmationToCustomer,
  sendOrderPlacedConfirmationToCustomer,
  sendRestockAvailableEmail,
  // Shared so the manual /send-invoice endpoint renders the attachment through
  // the same PDF → PNG chain as the automatic order emails.
  buildInvoiceAttachment,

  transporter,
  EMAIL_CONFIG,
};
