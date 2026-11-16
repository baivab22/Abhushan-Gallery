require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { transporter, EMAIL_CONFIG, buildCommonHeaders } = require("./mailConfig");
const { getLogoAttachment, buildEmailShell } = require('./emailTemplate');
const { buildInvoiceAttachment } = require('./emailServices');

const formatCurrency = (value) => {
  const amount = Number(value) || 0;
  return `NPR ${amount.toFixed(2)}`;
};

const normalizePhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return null;

  const raw = String(phoneNumber).trim();
  const digitsOnly = raw.replace(/\D/g, "");

  if (!digitsOnly) return null;
  if (raw.startsWith("+")) return `+${digitsOnly}`;

  if (digitsOnly.length === 10 && digitsOnly.startsWith("9")) {
    return `+977${digitsOnly}`;
  }

  if (digitsOnly.length === 10 && digitsOnly.startsWith("0")) {
    return `+977${digitsOnly.slice(1)}`;
  }

  return `+${digitsOnly}`;
};

const extractSingleEmail = (rawEmail) => {
  const candidate = String(rawEmail || '')
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .find(Boolean);

  if (!candidate) return '';
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate);
  return isValid ? candidate : '';
};

const sendDeliveryDispatchEmail = async (order) => {
  const customerEmail = extractSingleEmail(order?.userId?.email);
  if (!customerEmail) {
    return {
      sent: false,
      skipped: true,
      reason: 'Customer email not available',
    };
  }

  const customerName = order?.userId?.name || "Valued Customer";
  const orderId = order?.productOrderId || order?._id || "N/A";
  const scannedAt = order?.scannedAt ? new Date(order.scannedAt).toLocaleString() : new Date().toLocaleString();
  const deliveryPartner = order?.deliveryPartner || "Assigned shortly";
  const totalAmount = formatCurrency(order?.totalAmount);

  const productRows = (order?.products || [])
    .map((item) => {
      const productName = item?.productId?.name || "Product";
      const quantity = Number(item?.quantity) || 0;
      const lineTotal = Number(item?.price) || 0;
      return `<tr>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${productName}</td>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${quantity}</td>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatCurrency(lineTotal)}</td>
      </tr>`;
    })
    .join("");

  const shippingPrice = formatCurrency(order?.shippingPrice);
  const giftBoxCharge = formatCurrency(order?.giftBoxCharge);
  const emailSubject = `Order ${orderId} Dispatched to ${deliveryPartner}`;

  const emailBody = `
    <p>Dear ${customerName},</p>
    <p>
      Your order has been verified and dispatched to our delivery partner.
      Please find the details below.
    </p>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
      <p style="margin:4px 0;font-size:14px;"><strong>Order ID:</strong> <span style="font-family:monospace;">${orderId}</span></p>
      <p style="margin:4px 0;font-size:14px;"><strong>Dispatch Time:</strong> ${scannedAt}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Delivery Partner:</strong> ${deliveryPartner}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Total Amount:</strong> ${totalAmount}</p>
    </div>

    <h3 style="margin:16px 0 8px;font-size:16px;color:#374151;">Order Summary</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:10px;text-align:left;border-bottom:1px solid #e2e8f0;">Product</th>
          <th style="padding:10px;text-align:center;border-bottom:1px solid #e2e8f0;">Qty</th>
          <th style="padding:10px;text-align:right;border-bottom:1px solid #e2e8f0;">Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${productRows || "<tr><td colspan='3' style='padding:10px;text-align:center;color:#6b7280;'>No product lines available</td></tr>"}
      </tbody>
    </table>

    <div style="margin-top:16px;border-top:1px solid #e5e7eb;padding-top:12px;font-size:14px;">
      <p style="margin:4px 0;"><strong>Shipping Charge:</strong> ${shippingPrice}</p>
      <p style="margin:4px 0;"><strong>Gift Box Charge:</strong> ${giftBoxCharge}</p>
      <p style="margin:8px 0;font-size:16px;font-weight:700;"><strong>Final Total:</strong> ${totalAmount}</p>
    </div>

    <p style="margin-top:16px;font-size:14px;line-height:1.6;">
      If you have any questions, please contact our support team at ${EMAIL_CONFIG.sender}.
    </p>
  `;

  const textBody = `Dear ${customerName},

Your order has been dispatched to our delivery partner.

Order ID: ${orderId}
Dispatch Time: ${scannedAt}
Delivery Partner: ${deliveryPartner}
Total Amount: ${totalAmount}

Products:
${(order?.products || []).map(item => `- ${item?.productId?.name || 'Product'} (x${item?.quantity || 0}) - ${formatCurrency(item?.price || 0)}`).join('\n')}

Shipping: ${shippingPrice}
Gift Box: ${giftBoxCharge}
Final Total: ${totalAmount}

If you have questions, contact us at ${EMAIL_CONFIG.sender}.`;

  const mailOptions = {
    from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
    to: customerEmail,
    subject: emailSubject,
    html: buildEmailShell({
      subject: emailSubject,
      title: 'Order Dispatch Confirmation',
      subtitle: `Order #${orderId}`,
      bodyHtml: emailBody,
      footerNote: 'Your order is on the way. Keep this email for your records.',
      contactPhone: '9861698400',
      contactEmail: EMAIL_CONFIG.sender,
    }),
    text: textBody,
    headers: buildCommonHeaders({ to: customerEmail, subject: emailSubject }),
    replyTo: EMAIL_CONFIG.sender,
    attachments: getLogoAttachment(),
  };

  await transporter.sendMail(mailOptions);

  return {
    sent: true,
    skipped: false,
    recipientMode: 'customer-only',
  };
};

const sendWhatsAppDispatchMessage = async (order) => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const whatsappApiVersion = process.env.WHATSAPP_API_VERSION || "v20.0";

  if (!accessToken || !phoneNumberId) {
    return {
      sent: false,
      skipped: true,
      reason: "WhatsApp API credentials are not configured",
    };
  }

  const normalizedPhone = normalizePhoneNumber(order?.phoneNumber || order?.userId?.phone);
  if (!normalizedPhone) {
    return {
      sent: false,
      skipped: true,
      reason: "Customer phone number not available",
    };
  }

  const orderId = order?.productOrderId || order?._id || "N/A";
  const deliveryPartner = order?.deliveryPartner || "Assigned shortly";
  const totalAmount = formatCurrency(order?.totalAmount);

  const message = `Dear Customer, your order ${orderId} has been dispatched to ${deliveryPartner}. Total: ${totalAmount}. Thank you for shopping with us.`;

  const response = await fetch(`https://graph.facebook.com/${whatsappApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedPhone,
      type: "text",
      text: {
        body: message,
      },
    }),
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage =
      responseBody?.error?.message || "Failed to send WhatsApp dispatch message";
    throw new Error(errorMessage);
  }

  return {
    sent: true,
    skipped: false,
    providerMessageId: responseBody?.messages?.[0]?.id,
  };
};

const sendOrderDispatchedNotification = async (order) => {
  const result = {
    email: { sent: false, skipped: false },
    whatsapp: { sent: false, skipped: false },
  };

  try {
    result.email = await sendDeliveryDispatchEmail(order);
  } catch (error) {
    result.email = {
      sent: false,
      skipped: false,
      reason: error.message,
    };
  }

  try {
    result.whatsapp = await sendWhatsAppDispatchMessage(order);
  } catch (error) {
    result.whatsapp = {
      sent: false,
      skipped: false,
      reason: error.message,
    };
  }

  return result;
};

const sendOrderDeliveryStatusChangedNotification = async (order, statusChange = {}) => {
  const customerEmail =
    extractSingleEmail(order?.userId?.email) ||
    extractSingleEmail(order?.email);
  if (!customerEmail) {
    return {
      sent: false,
      skipped: true,
      reason: 'Customer email not available',
    };
  }

  const previousStatus = String(statusChange?.previousStatus || '').trim() || 'Unknown';
  const newStatus = String(statusChange?.newStatusLabel || statusChange?.newStatus || '').trim() || 'Unknown';
  const statusTime = statusChange?.statusTime ? new Date(statusChange.statusTime) : new Date();
  const statusTimeLabel = Number.isNaN(statusTime.getTime()) ? new Date().toLocaleString() : statusTime.toLocaleString();

  const customerName = order?.name || order?.userId?.name || order?.fullName || 'Valued Customer';
  const orderId = order?.productOrderId || order?._id || 'N/A';
  const currentTotal = formatCurrency(order?.totalAmount);

  const emailSubject = `Delivery Update: Order ${orderId} - ${newStatus}`;

  // Every status change carries the same PDF invoice as the confirmed-order
  // mail, so the customer always has an up-to-date document for the order
  // (including when an admin moves it to shipped/delivered from the dashboard).
  const invoiceAttachment = await buildInvoiceAttachment({
    order,
    customerEmail,
    customerName,
    senderEmail: EMAIL_CONFIG.sender,
    title: `Order Invoice - ${newStatus}`,
  });

  const invoiceNoteHtml = invoiceAttachment
    ? '<p style="font-size:14px;line-height:1.6;margin:16px 0;">We have attached your order invoice to this email for your records.</p>'
    : '';
  const invoiceNoteText = invoiceAttachment
    ? 'We have attached your order invoice to this email for your records.\n'
    : '';

  const emailBody = `
    <p>Dear ${customerName},</p>
    <p>Your delivery status has been updated.</p>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
      <p style="margin:4px 0;font-size:14px;"><strong>Order Reference:</strong> ${orderId}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Previous Status:</strong> ${previousStatus}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Current Status:</strong> ${newStatus}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Status Time:</strong> ${statusTimeLabel}</p>
      <p style="margin:4px 0;font-size:14px;"><strong>Order Total:</strong> ${currentTotal}</p>
    </div>

    ${invoiceNoteHtml}
    <p style="font-size:14px;line-height:1.6;">We will continue to share updates until your package is delivered.</p>
  `;

  const textBody = `Dear ${customerName},

Your delivery status has been updated.

Order Reference: ${orderId}
Previous Status: ${previousStatus}
Current Status: ${newStatus}
Status Time: ${statusTimeLabel}
Order Total: ${currentTotal}

${invoiceNoteText}We will continue to share updates until your package is delivered.
Contact us at ${EMAIL_CONFIG.sender} if you have questions.`;

  const mailOptions = {
    from: `"Abhushan Gallery" <${EMAIL_CONFIG.sender}>`,
    to: customerEmail,
    subject: emailSubject,
    html: buildEmailShell({
      subject: emailSubject,
      title: 'Delivery Status Update',
      subtitle: `Order #${orderId}`,
      bodyHtml: emailBody,
      footerNote: 'This is an automated delivery-tracking update.',
      contactPhone: '9861698400',
      contactEmail: EMAIL_CONFIG.sender,
    }),
    text: textBody,
    headers: buildCommonHeaders({ to: customerEmail, subject: emailSubject }),
    replyTo: EMAIL_CONFIG.sender,
    attachments: invoiceAttachment
      ? [...getLogoAttachment(), invoiceAttachment]
      : getLogoAttachment(),
  };

  await transporter.sendMail(mailOptions);

  return {
    sent: true,
    skipped: false,
    recipientMode: 'customer-only',
    invoiceAttached: Boolean(invoiceAttachment),
  };
};

module.exports = {
  sendOrderDispatchedNotification,
  sendOrderDeliveryStatusChangedNotification,
};
