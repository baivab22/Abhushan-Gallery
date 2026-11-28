const Cart = require("../modals/cart.modal"); 
const { Product } = require("../modals/product.modal");

const getRequestedQuantity = (value) => Math.max(1, Number(value || 1));
const normalizeVariant = (value) => String(value ?? "").trim();

// A cart can hold several lines for the same product when the shopper picks
// different colours and/or sizes. Updates must therefore target the matching
// line, not simply the first product with the same id.
const findCartItem = (cart, { productId, routeId, colorName, size }) => {
  const matchesId = (item) => {
    const itemProductId = String(item?.productId?._id || item?.productId || "");
    const lineId = String(item?._id || "");
    const requestedId = String(routeId || productId || "");
    return (
      (requestedId && itemProductId === requestedId) ||
      (requestedId && lineId === requestedId) ||
      (productId && itemProductId === String(productId))
    );
  };

  const candidates = (cart.products || []).filter(matchesId);
  const matchesVariant = (item) =>
    (colorName === undefined ||
      normalizeVariant(colorName) === normalizeVariant(item.colorName)) &&
    (size === undefined || normalizeVariant(size) === normalizeVariant(item.size));

  return candidates.find(matchesVariant) || candidates[0];
};

const getAvailableStock = async (productId) => {
  const product = await Product.findById(productId).select('stockQuantity');
  return Number(product?.stockQuantity || 0);
};

const getLineProductId = (item) =>
  String(item?.productId?._id || item?.productId || '');

// Stock is tracked per product, not per variant. Sum every cart line for that
// product so two sizes/colours cannot together exceed the available stock.
const quantityOfProduct = (cart, productId) =>
  (cart?.products || []).reduce(
    (total, item) =>
      getLineProductId(item) === String(productId)
        ? total + Number(item.quantity || 0)
        : total,
    0
  );

// Restock alerts are opt-in: only the explicit "Notify Me" action (cart or
// product page) creates a subscription. Adding/updating a cart item must never
// silently subscribe the shopper, otherwise people receive email they never
// asked for.

exports.createCart = async (req, res) => {
  try {
    const requestedProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    const requestedByProduct = new Map();
    for (const item of requestedProducts) {
      const productId = item?.productId;
      if (!productId) {
        return res.status(400).json({ message: 'productId is required for cart items' });
      }

      const key = String(productId);
      requestedByProduct.set(
        key,
        (requestedByProduct.get(key) || 0) + getRequestedQuantity(item?.quantity)
      );
    }

    const existingCart = await Cart.findOne({ userId: req.body.userId });

    for (const [productId, quantity] of requestedByProduct) {
      const stockQuantity = await getAvailableStock(productId);
      const alreadyInCart = quantityOfProduct(existingCart, productId);
      if (alreadyInCart + quantity > stockQuantity) {
        return res.status(400).json({
          message: `Only ${Math.max(0, stockQuantity - alreadyInCart)} items available in stock`,
        });
      }
    }

    if (existingCart) {
      existingCart.products.push(...req.body.products);
      const savedCart = await existingCart.save();

      res
        .status(200)
        .json({ data: savedCart, message: "Updated existing cart" });
    } else {
      const newCart = new Cart(req.body);
      const savedCart = await newCart.save();
      res
        .status(201)
        .json({ data: savedCart, message: "Successfully created cart" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getUsersCartByUserId = async (req, res) => {
  try {
    const cart = await Cart.find({ userId: req.params.userId })
      .populate({
        path: "products.productId",
        populate: {
          path: "images",
        },
      });

    if (!cart) {
      res.status(404).json({ message: "User not found" });
    } else {
      res.json({ data: cart, success: "successfully found cartitems" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateCartProduct = async (req, res) => {
  try {
    const { productId, userId, quantity, price, colorName, size } = req.body;

    console.log(quantity, "quantity");

    const cart = await Cart.findOne({ userId: userId });

    console.log("hello update cart hai ta");

    if (!cart) {
      console.log("if");
      return res.status(404).json({ message: "User not found" });
    } else {
      const productToUpdate = findCartItem(cart, {
        productId,
        routeId: req.params.productId,
        colorName,
        size,
      });
      if (productToUpdate) {
        const targetProductId =
          productToUpdate.productId?._id || productToUpdate.productId || productId;
        const stockQuantity = await getAvailableStock(targetProductId);
        const requestedQuantity = getRequestedQuantity(quantity);
        const otherLinesQuantity =
          quantityOfProduct(cart, targetProductId) -
          Number(productToUpdate.quantity || 0);

        if (otherLinesQuantity + requestedQuantity > stockQuantity) {
          return res.status(400).json({
            message: `Only ${Math.max(0, stockQuantity - otherLinesQuantity)} items available in stock`,
          });
        }

        console.log("else if", quantity, price);
        productToUpdate.quantity = requestedQuantity;
        productToUpdate.price = price;
        if (colorName !== undefined) productToUpdate.colorName = colorName;
        if (size !== undefined) productToUpdate.size = normalizeVariant(size) || undefined;
        const updatedCart = await cart.save();

        console.log(updatedCart, "updatedCart");
        res.status(201).json({
          data: updatedCart,
          message: "Successfully updated product cart",
        });
      } else {
        return res.status(404).json({ message: "Product not found in cart" });
      }
    }
  } catch (err) {
    console.log(err, "error");
    res.status(500).json({ error: err.message });
  }
};

// MODIFIED: Delete all products from cart
exports.deleteCart = async (req, res) => {
  try {
    console.log("Deleting all products from cart for userId:", req.params.userId);

    const cart = await Cart.findOne({ userId: req.params.userId });
    
    if (!cart) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Clear all products from the cart
    cart.products = [];
    
    const updatedCart = await cart.save();
    
    return res.json({ 
      data: updatedCart, 
      message: "Successfully deleted all products from cart" 
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteProductFromCart = async (req, res) => {
  console.log("delete product from cart");
  try {
    const { productId } = req.params;
    const { userId } = req.body;
    console.log("delete cart", productId, userId);

    const cart = await Cart.findOne({ userId: userId });
    console.log("cart", cart);
    if (!cart) {
      return res.status(404).json({ message: "User not found" });
    } else {
      console.log(cart.products, "cart products ");
      const productIndex = cart.products.findIndex(
        (product) => product?._id.toString() === productId
      );

      if (productIndex !== -1) {
        console.log(productIndex, "product index value");
        // Remove the product from the products array
        cart.products.splice(productIndex, 1);

        // Save the updated cart
        const updatedCart = await cart.save();

        return res.json({
          data: updatedCart,
          message: "Successfully deleted product from cart",
        });
      } else {
        return res.status(404).json({ message: "Product not found in cart" });
      }
    }
  } catch (err) {
    console.log("product index value error", err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteCartByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    console.log("Deleting entire cart for userId:", userId);

    const deletedCart = await Cart.findOneAndDelete({ userId: userId });

    if (!deletedCart) {
      return res.status(404).json({ message: "Cart not found for this user" });
    }

    return res.json({
      data: deletedCart,
      message: "Successfully deleted entire cart for user",
    });
  } catch (err) {
    console.log("Error deleting cart by userId:", err.message);
    return res.status(500).json({ error: err.message });
  }
};