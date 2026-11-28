const fs = require('fs');
const path = require('path');
const { getLogoPath } = require('./logoAsset.service');

const LOGO_PATH = getLogoPath();

const DEFAULT_LOGO_STYLE =
  'max-width:180px;width:100%;height:auto;display:block;margin:0 auto;';

const hasLogo = () => fs.existsSync(LOGO_PATH);

const getLogoAttachment = () => (
  hasLogo()
    ? [
        {
          filename: 'logo.png',
          path: LOGO_PATH,
          cid: 'brandLogo',
        },
      ]
    : []
);

const getLogoMarkup = ({ className = '', style = DEFAULT_LOGO_STYLE } = {}) => (
  hasLogo()
    ? `<img src="cid:brandLogo" alt="Brand Logo" class="${className}" style="${style}" />`
    : ''
);

const buildEmailShell = ({
  subject,
  title,
  subtitle = '',
  bodyHtml,
  footerNote = 'This is an automated message. Please do not reply to this email.',
  contactPhone = '9768620644',
  contactEmail = '',
}) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject || title || 'Notification'}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #f3f4f6;
      color: #111827;
      font-family: Arial, Helvetica, sans-serif;
    }
    .wrapper {
      width: 100%;
      padding: 28px 12px;
    }
    .card {
      max-width: 680px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 14px;
      border: 1px solid #e5e7eb;
      overflow: hidden;
      box-shadow: 0 8px 28px rgba(17, 24, 39, 0.08);
    }
    .header {
      background: linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
      padding: 24px 22px 16px;
      text-align: center;
      border-bottom: 1px solid #e5e7eb;
    }
    .title {
      margin: 14px 0 0;
      font-size: 22px;
      line-height: 1.25;
      font-weight: 700;
      color: #111827;
    }
    .subtitle {
      margin: 6px 0 0;
      font-size: 14px;
      color: #4b5563;
    }
    .content {
      padding: 24px 22px;
      font-size: 14px;
      line-height: 1.65;
      color: #1f2937;
    }
    .footer {
      padding: 18px 22px;
      border-top: 1px solid #e5e7eb;
      background: #f9fafb;
      font-size: 12px;
      text-align: center;
      color: #6b7280;
      line-height: 1.6;
    }
    .contact {
      margin-top: 8px;
      color: #4b5563;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    @media only screen and (max-width: 600px) {
      .wrapper {
        padding: 12px 8px;
      }
      .header,
      .content,
      .footer {
        padding-left: 14px;
        padding-right: 14px;
      }
      .title {
        font-size: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        ${getLogoMarkup()}
        ${title ? `<p class="title">${title}</p>` : ''}
        ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
      </div>
      <div class="content">${bodyHtml || ''}</div>
      <div class="footer">
        <div>${footerNote}</div>
        <div class="contact">Phone: ${contactPhone}${contactEmail ? ` | Email: ${contactEmail}` : ''}</div>
        <div style="margin-top:6px;">(c) ${new Date().getFullYear()} All rights reserved.</div>
      </div>
    </div>
  </div>
</body>
</html>
`;

module.exports = {
  getLogoAttachment,
  getLogoMarkup,
  buildEmailShell,
};
