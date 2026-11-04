const {
  subscribeUserToRestock,
  cancelRestockSubscription,
} = require("../services/restockNotification.service");

/**
 * POST /api/restock-notification/subscribe
 * Body: { productId }
 * Opts the authenticated user in for a ONE-TIME back-in-stock email.
 */
exports.subscribe = async (req, res) => {
  try {
    const { productId } = req.body || {};
    if (!productId) {
      return res.status(400).json({ message: "productId is required" });
    }

    const result = await subscribeUserToRestock({
      userId: req.user.userId,
      productId,
    });

    if (!result.subscribed) {
      const messages = {
        INVALID_REQUEST: "A valid product is required.",
        PRODUCT_NOT_FOUND:
          "Unable to register for restock notification. Product may no longer exist.",
        USER_NOT_FOUND: "Your account could not be found. Please log in again.",
        USER_INACTIVE:
          "Your account is not active. Please contact support to enable alerts.",
        EMAIL_MISSING:
          "Your account has no email address. Please add one before requesting an alert.",
      };
      return res.status(400).json({
        data: result,
        message:
          messages[result.reason] ||
          "Unable to register for restock notification. Please try again.",
      });
    }

    return res.status(200).json({
      data: result,
      message: result.alreadySubscribed
        ? "You are already registered for this restock alert"
        : "We will email you when this product is back in stock",
    });
  } catch (err) {
    console.error("[Restock] Subscribe failed:", err?.message || err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE /api/restock-notification/subscribe/:productId
 * Cancels the caller's pending restock alert for that product.
 */
exports.unsubscribe = async (req, res) => {
  try {
    const cancelled = await cancelRestockSubscription({
      userId: req.user.userId,
      productId: req.params.productId,
    });

    if (!cancelled) {
      return res
        .status(404)
        .json({ message: "No active restock alert found" });
    }

    return res.json({ message: "Restock alert cancelled" });
  } catch (err) {
    console.error("[Restock] Unsubscribe failed:", err?.message || err);
    return res.status(500).json({ error: err.message });
  }
};
