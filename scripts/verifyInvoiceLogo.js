/**
 * Verification for the A4 invoice pipeline.
 *
 *   node scripts/verifyInvoiceLogo.js
 *
 * Checks:
 *  1. PDF is generated and is a valid A4 document (595 x 842 pt MediaBox)
 *  2. Logo <img> actually loads inside headless Chrome
 *  3. No ellipsis/truncation anywhere (HTML, SVG, or data)
 *  4. Long product names / addresses survive in full
 */

const fs = require('fs');
const path = require('path');
const {
  buildInvoiceHtml,
  buildInvoiceSvg,
  generateInvoicePdfBuffer,
  extractInvoiceData,
} = require('../services/invoiceRenderer.service');

(async () => {
  const longProductName = 'Small Pearl And Large Stone On Both Sides With Traditional Gold Plated Tikma Necklace And Matching Earrings Set';
  const longAddress = 'House Number 123, Ward Number 14, Kalanki, Kuleshwar Chowk, Near The Old Bus Park, Kathmandu Metropolitan City, Kathmandu, Bagamati Province, 44614, Federal Democratic Republic Of Nepal';

  const order = {
    productOrderId: '65850',
    OrderedAt: new Date('2026-05-25T10:00:00Z'),
    paymentMethod: 'esewa',
    shippingPrice: 100,
    includeGiftBox: false,
    totalAmount: 10700,
    fullName: 'Baivab Bidari',
    shippingLocation: longAddress,
    locationAddress: '',
    phoneNumber: '+977 9768620644',
    products: [
      { productId: { name: longProductName }, colorName: 'Gold Polish', quantity: 1, price: 600 },
      { productId: { name: 'Traditional Tikma Necklace Set With Lapis Lazuli Beads' }, colorName: 'Oxidised Silver', quantity: 2, price: 10000 },
    ],
  };

  const params = { order, customerEmail: 'abhushangallery2023@gmail.com', customerName: 'Baivab Bidari', title: 'Order Confirmation' };
  const data = extractInvoiceData(params);
  const OUT_DIR = path.join(__dirname, 'output');

  let failed = false;
  const check = (label, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} : ${label}`);
    if (!ok) failed = true;
  };

  // 1. Full text preserved end-to-end
  check('full product name kept', JSON.stringify(data.items).includes(longProductName));
  check('full address kept', data.customer.address === longAddress);

  // 2. HTML has no ellipsis and contains full name + address
  const html = buildInvoiceHtml(data);
  fs.writeFileSync(path.join(OUT_DIR, 'invoice-example.html'), html, 'utf8');
  check('HTML has no ellipsis', !html.includes('\u2026'));
  check('HTML shows full product name', html.includes(longProductName));
  check('HTML shows full address', html.includes(longAddress));

  // 3. A4 PDF with logo
  const pdf = await generateInvoicePdfBuffer(data);
  if (!pdf) {
    console.log('FAIL : PDF generated');
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'invoice-example.pdf'), pdf);
  const pdfStr = pdf.toString('latin1');
  check('PDF magic header', pdfStr.startsWith('%PDF'));
  const mediaBox = pdfStr.match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const w = mediaBox ? Math.round(parseFloat(mediaBox[1])) : 0;
  const h = mediaBox ? Math.round(parseFloat(mediaBox[2])) : 0;
  check(`A4 size (${w} x ${h} pt)`, w === 595 && h === 842);

  // 4. SVG fallback wraps without truncation
  const svg = buildInvoiceSvg(data);
  fs.writeFileSync(path.join(OUT_DIR, 'invoice-example.svg'), svg, 'utf8');
  check('SVG has no ellipsis', !svg.includes('\u2026'));
  check('SVG embeds logo', svg.includes('<image') && svg.includes('data:image/png;base64,'));

  // 5. Logo renders inside the page
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const logoOk = await page.evaluate(() => {
    const img = document.querySelector('.logo-img');
    return !!img && img.naturalWidth > 0;
  });
  const a4WidthPx = await page.evaluate(() => {
    const el = document.querySelector('.page');
    return Math.round(el.getBoundingClientRect().width);
  });
  await browser.close();
  check('logo renders in HTML', logoOk);
  check(`page width is A4 (${a4WidthPx}px ~ 794)`, Math.abs(a4WidthPx - 794) <= 2);

  console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
