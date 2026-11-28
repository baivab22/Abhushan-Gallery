const User = require("../modals/userModal");
const { EMAIL_CONFIG, transporter } = require("./mailConfig");
const { getLogoAttachment, buildEmailShell } = require('./emailTemplate');

const emailMarketingService = {
  /**
   * Send bulk email to all users or specific segments
   */
  sendBulkEmail: async (emailData) => {
    try {
      const {
        subject,
        htmlContent,
        previewText,
        segment = 'all',
        testMode = false,
        testEmails = []
      } = emailData;

      // Validate required fields
      if (!subject || !htmlContent) {
        throw new Error('Subject and HTML content are required');
      }

      // Build query based on segment
      let userQuery = { 
        email: { $exists: true, $ne: null } 
      };

      switch (segment) {
        case 'active':
          userQuery.lastLoginAt = { 
            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) 
          };
          break;
        case 'recent':
          userQuery.createdAt = { 
            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) 
          };
          break;
        case 'all':
        default:
          break;
      }

      // Get users based on segment
      const users = testMode && testEmails.length > 0 
        ? testEmails.map(email => ({ email }))
        : await User.find(userQuery).select('email name').lean();

      if (!users || users.length === 0) {
        throw new Error('No users found for the selected segment');
      }

      const results = {
        total: users.length,
        sent: 0,
        failed: 0,
        errors: []
      };

      console.log(`📧 Starting bulk email send to ${users.length} users`);

      // Send emails in batches to avoid rate limiting
      const batchSize = 10;
      const delayBetweenBatches = 2000;

      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        const batchPromises = batch.map(async (user) => {
          try {
            const marketingBody = `
              <div>
                ${htmlContent}
              </div>
              <p style="margin-top:18px; font-size:13px; color:#6b7280;">
                You are receiving this email because you subscribed to updates.
              </p>
              <p style="margin-top:8px; font-size:13px;">
                <a href="https://youwebsite.com/unsubscribe?email=${user.email}" style="color:#2563eb; text-decoration:none;">Unsubscribe from marketing emails</a>
              </p>
            `;

            const mailOptions = {
              from: EMAIL_CONFIG.sender,
              to: user.email,
              subject: subject,
              html: buildEmailShell({
                subject,
                title: subject,
                subtitle: 'Latest updates curated for you',
                bodyHtml: marketingBody,
                footerNote: 'You are receiving this message because you subscribed to updates.',
                contactPhone: '9768620644',
                contactEmail: EMAIL_CONFIG.sender,
              }),
              text: previewText || subject,
              attachments: getLogoAttachment()
            };

            await transporter.sendMail(mailOptions);
            results.sent++;
            
            console.log(`✅ Email sent to: ${user.email}`);
            
          } catch (error) {
            results.failed++;
            results.errors.push({
              email: user.email,
              error: error.message
            });
            console.error(`❌ Failed to send to ${user.email}:`, error.message);
          }
        });

        await Promise.all(batchPromises);
        
        if (i + batchSize < users.length) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
      }

      console.log(`📧 Bulk email completed: ${results.sent} sent, ${results.failed} failed`);
      return results;

    } catch (error) {
      console.error('Bulk email error:', error);
      throw error;
    }
  },

  /**
   * Get email statistics and user segments
   */
  getEmailStats: async () => {
    try {
      const totalUsers = await User.countDocuments({ 
        email: { $exists: true, $ne: null } 
      });
      
      const activeUsers = await User.countDocuments({ 
        email: { $exists: true, $ne: null },
        lastLoginAt: { 
          $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) 
        } 
      });
      
      const recentUsers = await User.countDocuments({ 
        email: { $exists: true, $ne: null },
        createdAt: { 
          $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) 
        } 
      });

      return {
        totalUsers,
        activeUsers,
        recentUsers,
        segments: {
          all: totalUsers,
          active: activeUsers,
          recent: recentUsers
        }
      };
    } catch (error) {
      console.error('Error getting email stats:', error);
      throw error;
    }
  },

  /**
   * Validate email addresses
   */
  validateEmails: (emails) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = [];
    const invalidEmails = [];

    emails.forEach(email => {
      if (emailRegex.test(email)) {
        validEmails.push(email);
      } else {
        invalidEmails.push(email);
      }
    });

    return { validEmails, invalidEmails };
  },

  /**
   * Basic HTML sanitization
   */
  sanitizeHtml: (html) => {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+="[^"]*"/g, '')
      .replace(/on\w+='[^']*'/g, '')
      .replace(/javascript:/gi, '')
      .replace(/vbscript:/gi, '');
  }
};

module.exports = emailMarketingService;