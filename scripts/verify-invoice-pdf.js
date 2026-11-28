/**
 * Verifies all three invoice PDF paths (no email, no database needed):
 *
 *   1. Chromium (puppeteer) renderer — the primary path.
 *   2. Native (pdfkit) renderer — the Chromium-free fallback.
 *   3. Bare renderer — zero-dependency last resort (no Chrome, no pdfkit),
 *      the PDF file format written by hand with Node built-ins.
 *
 * The native and bare output must be real, readable PDF text: the required
 * strings are decoded straight out of the Flate content streams below.
 *
 * Run with: npm run verify:invoice-pdf
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  generateInvoicePdfBuffer,
  generateInvoiceNativePdfBuffer,
  generateInvoiceBarePdfBuffer,
} = require('../services/invoiceRenderer.service');

const order = {
  _id: '64f000000000000000000001',
  productOrderId: 'ORD-TEST-1001',
  date: new Date(),
  name: 'Sita Sharma',
  shippingLocation: 'Kathmandu',
  locationAddress: 'Balaju, Block 3',
  phoneNumber: '+977 9768620644',
  paymentMethod: 'esewa',
  shippingPrice: 150,
  totalAmount: 4500,
  products: [
    { productId: { name: 'Gold Plated Marigold Ring' }, quantity: 2, price: 3000, colorName: 'Gold' },
    { productId: { name: 'Silver Zircon Necklace Set' }, quantity: 1, price: 1350, colorName: 'Silver' },
  ],
};

const params = {
  order,
  customerEmail: 'sita@example.com',
  customerName: 'Sita Sharma',
  senderEmail: 'support@aabhushangallery.com',
  title: 'Order Confirmation',
};

// Decompress every Flate stream in the PDF and turn the text-showing
// operators ([<hex> ...] TJ / (literal) Tj) back into readable characters.
const readText = (buf) => {
  const raw = buf.toString('latin1');
  const re = /stream\r?\n/g;
  const chunks = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    // Image XObjects (the header logo) are binary — never decode them as text.
    const dict = raw.slice(Math.max(0, m.index - 400), m.index);
    if (!dict.includes('/Subtype /Image')) {
      try {
        const stream = zlib.inflateSync(buf.slice(start, end)).toString('latin1');
        if (/TJ|Tj/.test(stream)) chunks.push(stream);
      } catch {
        /* not a Flate stream */
      }
    }
    // Step past "endstream" so the next match is the following stream, not the
    // "stream" keyword hidden inside the "endstream" keyword itself.
    re.lastIndex = end + 'endstream'.length;
  }

  return chunks
    .join('\n')
    // hex strings inside a TJ array (pdfkit's style)
    .replace(/\[((?:<[0-9a-fA-F]+>|[-\d. ]+)+)\]\s*TJ/g, (whole, array) =>
      [...array.matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join(''))
    // literal strings shown with Tj (the bare renderer's style)
    .replace(/\((?:\\.|[^\\()])*\)\s*Tj/g, (whole) => {
      const inner = whole.slice(1, whole.lastIndexOf(')'));
      return inner.replace(/\\([()\\])/g, '$1');
    });
};

const REQUIRED_TEXT = [
  'INVOICE',
  'Abhushan Gallery',
  'Sita Sharma',
  'Gold Plated Marigold Ring',
  'NPR 4,500.00',
  'Amount in words',
  'NPR Four Thousand Five Hundred Only',
];

// Payment display cases: a partial settlement prints the advance paid plus the
// balance still due, while a fully settled order prints the amount paid with
// nothing due.
const scenarios = [
  {
    name: 'partial',
    params: { ...params, order: { ...order, paymentMode: 'partial' } },
    required: [...REQUIRED_TEXT, 'Amount Paid', 'Balance Due', 'NPR 4,350.00'],
  },
  {
    name: 'full',
    params: { ...params, order: { ...order, paymentMode: 'full' } },
    required: [...REQUIRED_TEXT, 'Amount Paid', 'Balance Due', 'NPR 0.00'],
  },
];

const assertText = (label, buf, required) => {
  const text = readText(buf);
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length) {
    console.error(`FAIL: ${label} is missing text:`, missing);
    process.exit(1);
  }
};

(async () => {
  for (const scenario of scenarios) {
    const native = await generateInvoiceNativePdfBuffer(scenario.params);
    if (!native || native.length < 500) {
      console.error(`FAIL: native PDF not generated (${scenario.name})`, native && native.length);
      process.exit(1);
    }
    fs.writeFileSync(path.join(__dirname, 'output', `verify-invoice-native-${scenario.name}.pdf`), native);
    assertText(`native PDF (${scenario.name})`, native, scenario.required);
    console.log(`PASS: native PDF (${scenario.name}) ${native.length} bytes, all required text present`);

    const bare = await generateInvoiceBarePdfBuffer(scenario.params);
    if (!bare || bare.length < 500 || bare.slice(0, 5).toString('latin1') !== '%PDF-') {
      console.error(`FAIL: bare PDF not generated (${scenario.name})`, bare && bare.length);
      process.exit(1);
    }
    fs.writeFileSync(path.join(__dirname, 'output', `verify-invoice-bare-${scenario.name}.pdf`), bare);
    assertText(`bare PDF (${scenario.name})`, bare, scenario.required);
    console.log(`PASS: bare (zero-dependency) PDF (${scenario.name}) ${bare.length} bytes, all required text present`);
  }

  const chromium = await generateInvoicePdfBuffer({
    ...params,
    order: { ...order, paymentMode: 'partial' },
  });
  if (chromium && chromium.length) {
    console.log(`PASS: Chromium PDF ${chromium.length} bytes`);
  } else {
    console.log('NOTE: Chromium PDF unavailable — the native/bare renderers above will be used');
  }
})();
