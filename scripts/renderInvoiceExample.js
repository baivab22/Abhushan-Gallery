/**
 * Example / test renderer for the A4 invoice PDF.
 *
 * Generates a PDF using the same pipeline as the email attachments:
 *
 *   node scripts/renderInvoiceExample.js
 *
 * Output: server/scripts/output/invoice-example.pdf (+ .html for debugging)
 */

const fs = require('fs');
const path = require('path');
const {
  buildInvoiceHtml,
  generateInvoicePdfBuffer,
} = require('../services/invoiceRenderer.service');

// ─── REFERENCE EXAMPLE DATA ──────────────────────────────────────────────────
const referenceInvoiceData = {
  invoiceNo: '65850',
  orderNo: '65850',
  date: 'May 25, 2026',
  currency: 'NPR',
  title: 'Order Confirmation',

  seller: {
    name: 'Abhushan Gallery',
    address: 'Kalimati, Kathmandu, Nepal',
    phone: '+977 9768620644',
    email: 'baivabidari876@gmail.com',
  },

  customer: {
    name: 'Baivab Bidari',
    address:
      'kkkkkkk, Kalanki, Kuleshwar, Kathmandu-14, Kathmandu Metropolitan City, Kathmandu, Bagamati Province, 44614, Nepal',
    phone: '4343434343',
    email: 'abhushangallery2023@gmail.com',
  },

  items: [
    {
      name: 'Small Pearl And large Stone On Both Side',
      quantity: 1,
      unitPrice: 600,
      amount: 600,
    },
  ],

  subtotal: 600,
  shippingFee: 100,
  giftBoxCharge: 0,
  totalAmount: 700,
  totalItems: 1,
};

const OUT_DIR = path.join(__dirname, 'output');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const html = buildInvoiceHtml(referenceInvoiceData);
  fs.writeFileSync(path.join(OUT_DIR, 'invoice-example.html'), html, 'utf8');

  const pdf = await generateInvoicePdfBuffer(referenceInvoiceData);
  if (!pdf) {
    console.error(
      'PDF generation failed (headless Chrome unavailable on this host). ' +
        'Emails will attach the vector SVG invoice instead.'
    );
    process.exit(1);
  }
  const pdfPath = path.join(OUT_DIR, 'invoice-example.pdf');
  fs.writeFileSync(pdfPath, pdf);

  console.log('HTML written to:', path.join(OUT_DIR, 'invoice-example.html'));
  console.log('PDF written to :', pdfPath);
  console.log('PDF size       :', `${pdf.length.toLocaleString()} bytes`);
})();
