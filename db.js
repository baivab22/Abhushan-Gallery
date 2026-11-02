const mongoose = require("mongoose");

// Build the order-ID indexes on boot (Mongoose will not recreate an existing
// index unnecessarily). The `productOrderId` unique index is what guarantees
// that concurrent order creations can never commit the same public order ID.
const ensureOrderIndexes = async () => {
  try {
    const Orders = require("./modals/orderModal");
    await Orders.ensureIndexes();
    console.log("Order ID unique index ensured.");
  } catch (error) {
    // Never take the API down if the index cannot be built (for example, a
    // pre-existing duplicate that needs manual cleanup). Order creation still
    // retries duplicate-key errors against whatever index exists.
    console.error("Could not ensure Order ID unique index:", error.message);
  }
};

mongoose
  .connect(process.env.DBHOST)
  .then(() => {
    console.log("MongoDB Connected...");
    return ensureOrderIndexes();
  })
  .catch((err) => {
    console.log("Error while Mongo Conn..", err);
  });
