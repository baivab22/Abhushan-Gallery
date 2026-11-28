/**
 * End-to-end check of the "Order Confirmed" email WITHOUT sending anything:
 * the SMTP transport's sendMail is replaced with a capture, so the exact
 * message (including attachments) that a customer would receive is recorded.
 *
 * Run with:      node scripts/verify-confirmed-email-attachment.js
 * Run with:      node scripts/verify-confirmed-email-attachment.js --no-chrome
 * Run with:      node scripts/verify-confirmed-email-attachment.js --no-deps
 *   --no-chrome hides `puppeteer` from the module loader (host without a
 *   Chrome binary); --no-deps hides `puppeteer` AND `pdfkit`, to prove the
 *   zero-dependency bare renderer still attaches a real PDF.
 */
const Module = require('module');

const blockedModules = new Set();
if (process.argv.includes('--no-chrome')) blockedModules.add('puppeteer');
if (process.argv.includes('--no-deps')) ['puppeteer', 'pdfkit'].forEach((m) => blockedModules.add(m));

if (blockedModules.size) {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (blockedModules.has(request)) {
      const err = new Error(`Cannot find module '${request}' (blocked by verify flag)`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalResolve.call(this, request, ...rest);
  };
  console.log(`[test] simulating a host WITHOUT: ${[...blockedModules].join(', ')}`);
}

const mailConfig = require('../services/mailConfig');

const captured = [];
mailConfig.transporter.sendMail = async (message) => {
  captured.push(message);
  return { messageId: 'capture-only', date: new Date() };
};

const { sendOrderConfirmationToCustomer } = require('../services/emailServices');

// Shape of a populated order document coming out of Mongo.
const order = {
  _id: { toString: () => '64f0000000000000000000aa' },
  productOrderId: 'AG-2026-00142',
  date: new Date(),
  name: 'Sita Sharma',
  email: 'sita@example.com',
  userId: { _id: '64f0000000000000000000bb', email: 'sita@example.com', name: 'Sita Sharma' },
  shippingLocation: 'Kathmandu',
  locationAddress: 'Balaju, Block 3',
  phoneNumber: '+977 9768620644',
  paymentMethod: 'esewa',
  shippingPrice: 150,
  totalAmount: 4500,
  isHomeDelivery: true,
  isInsideValley: true,
  products: [
    {
      productId: { _id: '64f0000000000000000000cc', name: 'Gold Plated Marigold Ring' },
      quantity: 2,
      price: 3000,
      colorName: 'Gold',
    },
    {
      productId: { _id: '64f0000000000000000000dd', name: 'Silver Zircon Necklace Set' },
      quantity: 1,
      price: 1350,
      colorName: 'Silver',
    },
  ],
};

(async () => {
  const sent = await sendOrderConfirmationToCustomer(order);
  console.log('sendOrderConfirmationToCustomer returned:', sent);

  if (!captured.length) {
    console.error('FAIL: no message was handed to the transport at all');
    process.exit(1);
  }

  const message = captured[0];
  const attachments = message.attachments || [];
  console.log('to:', message.to, '| subject:', message.subject);
  console.log('attachments:', attachments.length);

  if (!attachments.length) {
    console.error('FAIL: confirmation email has no attachment');
    process.exit(1);
  }

  for (const att of attachments) {
    const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content || '');
    console.log(
      `  - ${att.filename} | ${att.contentType} | ${buf.length} bytes | magic: ${buf.slice(0, 8).toString('latin1')}`
    );
    if (att.contentType !== 'application/pdf' || buf.slice(0, 5).toString('latin1') !== '%PDF-') {
      console.error('FAIL: attachment is not a PDF:', att.filename, att.contentType);
      process.exit(1);
    }
  }

  const body = String(message.html || '');
  console.log(
    body.includes('We have attached your order invoice')
      ? 'PASS: email body mentions the attached invoice'
      : 'NOTE: email body does not mention the invoice'
  );
  console.log('PASS: confirmation email carries a PDF invoice attachment');
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
