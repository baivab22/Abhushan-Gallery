const { Product, ProductImage } = require("../modals/product.modal");
const {
  Category,
  SubCategory,
  SubCategoryNested,
} = require("../modals/category.modal");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const {
  notifySubscribersOfRestock,
  didRestock,
} = require("../services/restockNotification.service");

const getUploadedFiles = (files, fieldName) => {
  if (!files) return [];
  if (Array.isArray(files)) {
    return files.filter((file) => {
      if (fieldName === "video") {
        return /^video\//i.test(file.mimetype || "") || file.fieldname === fieldName;
      }

      if (fieldName === "coloredImage") {
        return /^image\//i.test(file.mimetype || "") || file.fieldname === fieldName;
      }

      return file.fieldname === fieldName;
    });
  }
  return Array.isArray(files[fieldName]) ? files[fieldName] : [];
};

const parseBodyArray = (value) => {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
};

const parseColorNames = (body) => {
  const raw = body.colorName;
  if (raw === undefined || raw === null || raw === "") return [];
  const names = parseBodyArray(raw);
  return names.map((name) => String(name).trim()).filter(Boolean);
};

const groupUploadedColorFilesByColorName = (body, colorImages) => {
  const colorNames = parseColorNames(body);
  const grouped = {};

  for (let index = 0; index < colorImages.length; index++) {
    const filename = colorImages[index].filename;
    const colorName = (colorNames[index] && String(colorNames[index]).trim()) || `Color ${index + 1}`;

    if (!grouped[colorName]) {
      grouped[colorName] = [];
    }
    grouped[colorName].push(filename);
  }

  return grouped;
};

const toPlainImage = (img) => {
  if (!img) return null;
  if (typeof img.toObject === "function") {
    img = img.toObject();
  }

  const coloredImages = Array.isArray(img.coloredImages)
    ? img.coloredImages.filter(Boolean)
    : [];

  if (coloredImages.length === 0) {
    return null;
  }

  // Map to full URLs for each image
  const urlPrefix = "/uploads/products/";
  const coloredImageUrls = coloredImages.map((filename) =>
    filename.startsWith("http") ? filename : urlPrefix + filename
  );

  return {
    colorName: img.colorName,
    coloredImages: coloredImageUrls,
  };
};

const toRawImage = (img) => {
  if (!img) return null;
  if (typeof img.toObject === "function") {
    img = img.toObject();
  }

  const coloredImages = Array.isArray(img.coloredImages)
    ? img.coloredImages.filter(Boolean)
    : img.coloredImage
    ? [img.coloredImage]
    : [];

  if (coloredImages.length === 0) {
    return null;
  }

  return {
    colorName: img.colorName,
    coloredImages,
  };
};

const buildColorVariantImages = (colorNames, colorImages) => {
  const variants = [];

  for (let index = 0; index < colorImages.length; index++) {
    const colorName = (colorNames[index] && String(colorNames[index]).trim()) || `Color ${index + 1}`;
    const filename = colorImages[index].filename;
    const existing = variants.find((variant) => variant.colorName === colorName);

    if (existing) {
      existing.coloredImages.push(filename);
    } else {
      variants.push({
        colorName,
        coloredImages: [filename],
      });
    }
  }

  return variants;
};

const getVideoFilePaths = (filename) => ({
  primary: path.join(__dirname, "../uploads/video", filename),
  legacy: path.join(__dirname, "../uploads/products", filename),
});

const deleteVideoFile = async (filename) => {
  if (!filename) return;
  const { primary, legacy } = getVideoFilePaths(filename);
  await deleteFile(primary);
  await deleteFile(legacy);
};

exports.createProduct = async (req, res, next) => {
  try {
    console.log("Creating product with files:", req.files);
    console.log("Product data:", req.body);

    // ✅ VALIDATION: Check required fields (price is optional, use originalPrice instead)
    const requiredFields = ['name', 'stockQuantity', 'category', 'subCategory'];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    let images = [];

    try {
      // ✅ Process uploaded color images if provided
      // Support unlimited images by allowing multiple batch uploads if needed
      const colorImages = getUploadedFiles(req.files, "coloredImage");
      if (colorImages.length > 0) {
        
        // Get color names - handle multiple formats
        let colorNames = [];
        if (Array.isArray(req.body.colorName)) {
          colorNames = req.body.colorName.filter(name => name && name.trim());
        } else if (typeof req.body.colorName === 'string' && req.body.colorName.trim()) {
          colorNames = [req.body.colorName.trim()];
        }

        console.log(`Creating product with ${colorImages.length} image(s), ${colorNames.length} color name(s)`);

        // Auto-fill missing color names
        for (let i = colorNames.length; i < colorImages.length; i++) {
          colorNames.push(`Color ${i + 1}`);
        }

        // Group same-color uploads into a single color variant
        const groupedVariants = buildColorVariantImages(colorNames, colorImages);
        images = groupedVariants;

        groupedVariants.forEach((variant) => {
          console.log(
            `Added image variant: ${variant.colorName} (${variant.coloredImages.join(", ")})`
          );
        });
      }

      // Get video if provided
      let videoFilename = null;
      const uploadedVideos = getUploadedFiles(req.files, "video");
      if (uploadedVideos.length > 0) {
        const uploadedVideo = uploadedVideos[0];
        if (!uploadedVideo.size) {
          return res.status(400).json({ error: "Uploaded video file is empty" });
        }
        videoFilename = uploadedVideo.filename;
        console.log(`Added video: ${videoFilename}`);
      }

      // ✅ VALIDATION: Convert numeric fields (price and originalPrice are optional)
      const price = req.body.price ? Number(req.body.price) : null;
      const stockQuantity = Number(req.body.stockQuantity);
      const originalPrice = req.body.originalPrice ? Number(req.body.originalPrice) : null;
      const discountedPrice = req.body.discountedPrice ? Number(req.body.discountedPrice) : null;
      const discountPercentage = req.body.discountPercentage ? Number(req.body.discountPercentage) : null;

      // Validate only if provided
      if (price !== null && (isNaN(price) || price < 0)) {
        return res.status(400).json({ error: "Price must be a valid positive number" });
      }
      if (isNaN(stockQuantity) || stockQuantity < 0) {
        return res.status(400).json({ error: "Stock quantity must be a valid positive number" });
      }

      // Create the product
      const newProduct = new Product({
        name: req.body.name.trim(),
        price: price,
        stockQuantity: stockQuantity,
        images: images,
        video: videoFilename,
        originalPrice: originalPrice,
        discountedPrice: discountedPrice,
        category: req.body.category,
        subCategory: req.body.subCategory,
        nestedSubCategory: req.body.nestedSubCategory || null,
        discountPercentage: discountPercentage,
        description: req.body.description ? req.body.description.trim() : "",
        isNewArrivals: req.body.isNewArrivals === 'true' || req.body.isNewArrivals === true,
        isBestSelling: req.body.isBestSelling === 'true' || req.body.isBestSelling === true,
        isWatchAndShop: req.body.isWatchAndShop === 'true' || req.body.isWatchAndShop === true,
        showInHomePage: req.body.showInHomePage === 'true' || req.body.showInHomePage === true,
        isHotSelling: req.body.isHotSelling === 'true' || req.body.isHotSelling === true,
      });

      const savedProduct = await newProduct.save();
      
      console.log(`✅ Product created successfully with ${images.length} image variant(s):`, savedProduct._id);
      
      res.status(201).json({
        message: `Product created successfully with ${images.length} image variant(s)`,
        data: savedProduct,
      });
    } catch (createError) {
      // ✅ CLEANUP: Delete any uploaded image files if product creation fails
      console.error("Error during product creation, cleaning up files:", createError);
      const uploadedColorImages = getUploadedFiles(req.files, "coloredImage");
      if (uploadedColorImages.length > 0) {
        for (const file of uploadedColorImages) {
          try {
            const filePath = path.join(__dirname, "../uploads/products", file.filename);
            deleteFileSync(filePath);
          } catch (err) {
            console.error(`Error deleting file ${file.filename}:`, err);
          }
        }
      }
      const uploadedVideos = getUploadedFiles(req.files, "video");
      if (uploadedVideos[0]) {
        try {
          const { primary, legacy } = getVideoFilePaths(uploadedVideos[0].filename);
          deleteFileSync(primary);
          deleteFileSync(legacy);
        } catch (err) {
          console.error(`Error deleting video file:`, err);
        }
      }
      throw createError;
    }
  } catch (error) {
    console.error("Error creating product:", error);
    return res.status(500).json({
      error: error.message || "Failed to create product",
    });
  }
};



/* =====================================
   GET ALL PRODUCTS (LATEST FIRST)
===================================== */
// exports.getAllProduct = async (req, res) => {
//   const {
//     search,
//     minPrice,
//     maxPrice,
//     categoryId,
//     subCategoryId,
//     nestedSubCategoryId,
//     isNewArrivals,
//     isBestSelling,
//     isWatchAndShop,
//     page = 1,
//     limit = 12,
//   } = req.query;

//   try {
//     const query = {};

//     /* ---------- Search ---------- */
//     if (search && search.trim()) {
//       query.name = { $regex: search.trim(), $options: "i" };
//     }

//     /* ---------- Flag Filters ---------- */
//     if (isBestSelling === "true") query.isBestSelling = true;
//     if (isNewArrivals === "true") query.isNewArrivals = true;
//     if (isWatchAndShop === "true") query.isWatchAndShop = true;

//     /* ---------- Category Priority ---------- */
//     if (nestedSubCategoryId?.trim()) {
//       query.nestedSubCategory = nestedSubCategoryId;
//     } else if (subCategoryId?.trim()) {
//       query.subCategory = subCategoryId;
//     } else if (categoryId?.trim()) {
//       query.category = categoryId;
//     }

//     /* ---------- Price Filter ---------- */
//     if (minPrice || maxPrice) {
//       query.discountedPrice = {};
//       if (minPrice) query.discountedPrice.$gte = Number(minPrice);
//       if (maxPrice) query.discountedPrice.$lte = Number(maxPrice);
//     }

//     /* ---------- Pagination ---------- */
//     const pageNum = Math.max(Number(page), 1);
//     const limitNum = Math.max(Number(limit), 1);
//     const skip = (pageNum - 1) * limitNum;

//     /* ---------- Count ---------- */
//     const totalProducts = await Product.countDocuments(query);

//     /* ---------- Fetch Products ---------- */
//     const products = await Product.find(query)
//       .populate("category")
//       .populate("subCategory")
//       .populate("nestedSubCategory")
//       .populate("images")
//       // ✅ ALWAYS LATEST UPLOADED FIRST
//       .sort({ createdAt: -1 })
//       .skip(skip)
//       .limit(limitNum)
//       .lean();

//     res.status(200).json({
//       message: "Products fetched successfully",
//       data: products,
//       pagination: {
//         currentPage: pageNum,
//         totalPages: Math.ceil(totalProducts / limitNum),
//         totalProducts,
//         limit: limitNum,
//       },
//     });
//   } catch (error) {
//     console.error("Error fetching products:", error);
//     res.status(500).json({
//       message: "Failed to fetch products",
//       error: error.message,
//     });
//   }
// };



// exports.getAllProduct = async (req, res, next) => {
//   const {
//     search,
//     sort,
//     order,
//     minPrice,
//     maxPrice,
//     categoryId,
//     subCategoryId,
//     nestedSubCategoryId,
//     isNewArrivals,
//     isBestSelling,
//     isWatchAndShop,
//     page = 1,
//     limit = 12,
//   } = req.query;
  
//   try {
//     let query = {};
//     // Advanced search: trim, collapse whitespace, match name/description, fuzzy/partial
//     if (search && typeof search === 'string' && search.trim()) {
//       // Clean up search string
//       const cleaned = search.trim().replace(/\s+/g, ' ');
//       // Fuzzy regex: allow partial matches, ignore case, match anywhere in name or description
//       const regex = new RegExp(cleaned.split(' ').join('.*'), 'i');
//       query.$or = [
//         { name: { $regex: regex } },
//         { description: { $regex: regex } }
//       ];
//     }

//     if (isBestSelling === 'true') {
//       query.isBestSelling = true;
//     }
//     if (isNewArrivals === 'true') {
//       query.isNewArrivals = true;
//     }
//     if (isWatchAndShop === 'true') {
//       query.isWatchAndShop = true;
//     }

//     // Handle category filtering with hierarchical priority
//     // Priority: nestedSubCategoryId (highest) > subCategoryId > categoryId (lowest)
//     // Only filter by the most specific category level provided
//     if (nestedSubCategoryId && nestedSubCategoryId.trim() !== "") {
//       // Nested subcategory has highest priority - only filter by this
//       query.nestedSubCategory = nestedSubCategoryId;
//     } else if (subCategoryId && subCategoryId.trim() !== "") {
//       // Subcategory has medium priority - only filter by this if no nested subcategory
//       query.subCategory = subCategoryId;
//     } else if (categoryId && categoryId.trim() !== "") {
//       // Category has lowest priority - only filter by this if no subcategories provided
//       query.category = categoryId;
//     }

//     // Price filtering
//     if (minPrice || maxPrice) {
//       query.discountedPrice = {};
//       if (minPrice) {
//         query.discountedPrice.$gte = parseInt(minPrice);
//       }
//       if (maxPrice) {
//         query.discountedPrice.$lte = parseInt(maxPrice);
//       }
//     }

//     // Sort products
//     let sortOption = {};
//     if (sort === "price") {
//       sortOption.originalPrice = order === "asc" ? 1 : -1;
//     } else if (sort === "name") {
//       sortOption.name = order === "asc" ? 1 : -1;
//     } else {
//       // Default sort: latest created items first (newest to oldest)
//       sortOption.createdAt = -1;
//     }

//     // Pagination
//     const pageNum = parseInt(page);
//     const limitNum = parseInt(limit);
//     const skip = (pageNum - 1) * limitNum;

//     // Get total count for pagination info
//     const totalProducts = await Product.countDocuments(query);

//     // Fetch products with pagination
//     const products = await Product.find(query)
//       .populate("category")
//       .populate("subCategory")
//       .populate("nestedSubCategory")
//       .sort(sortOption)
//       .skip(skip)
//       //  .lean()
//       .limit(limitNum);

//     res.status(200).json({ 
//       message: "Successfully retrieved products", 
//       data: products,
//       pagination: {
//         currentPage: pageNum,
//         totalPages: Math.ceil(totalProducts / limitNum),
//         totalProducts: totalProducts,
//         limit: limitNum
//       }
//     });
    
//   } catch (err) {
//     console.error("Error fetching products:", err);
//     res.status(500).json({ error: "Error fetching products" });
//   }
// };
// exports.getAllProduct = async (req, res, next) => {
//   const {
//     search,
//     sort,
//     order,
//     minPrice,
//     maxPrice,
//     categoryId,
//     subCategoryId,
//     nestedSubCategoryId,
//     isNewArrivals,
//     isBestSelling,
//     isWatchAndShop,
//     showInHomePage,
//     page = 1,
//     limit = 12,
//   } = req.query;
  
//   try {
//     let query = {};
    
//     // Advanced search: trim, collapse whitespace, match name/description, fuzzy/partial
//     if (search && typeof search === 'string' && search.trim()) {
//       // Clean up search string
//       const cleaned = search.trim().replace(/\s+/g, ' ');
//       // Fuzzy regex: allow partial matches, ignore case, match anywhere in name or description
//       const regex = new RegExp(cleaned.split(' ').join('.*'), 'i');
//       query.$or = [
//         { name: { $regex: regex } },
//         { description: { $regex: regex } }
//       ];
//     }

//     if (isBestSelling === 'true') {
//       query.isBestSelling = true;
//     }
//     if (isNewArrivals === 'true') {
//       query.isNewArrivals = true;
//     }
//     if (isWatchAndShop === 'true') {
//       query.isWatchAndShop = true;
//     }
//     if (showInHomePage === 'true') {
//       query.showInHomePage = true;
//     }

//     // Handle category filtering with hierarchical priority
//     // Priority: nestedSubCategoryId (highest) > subCategoryId > categoryId (lowest)
//     // Only filter by the most specific category level provided
//     if (nestedSubCategoryId && nestedSubCategoryId.trim() !== "") {
//       // Nested subcategory has highest priority - only filter by this
//       query.nestedSubCategory = nestedSubCategoryId;
//     } else if (subCategoryId && subCategoryId.trim() !== "") {
//       // Subcategory has medium priority - only filter by this if no nested subcategory
//       query.subCategory = subCategoryId;
//     } else if (categoryId && categoryId.trim() !== "") {
//       // Category has lowest priority - only filter by this if no subcategories provided
//       query.category = categoryId;
//     }

//     // Price filtering - using discountedPrice
//     if (minPrice || maxPrice) {
//       query.discountedPrice = {};
//       if (minPrice) {
//         query.discountedPrice.$gte = parseInt(minPrice);
//       }
//       if (maxPrice) {
//         query.discountedPrice.$lte = parseInt(maxPrice);
//       }
//     }

//     // Sort products - FIXED to use discountedPrice
//     let sortOption = {};
//     if (sort === "discountedPrice") {
//       // Sort by discounted price (the actual selling price)
//       sortOption.discountedPrice = order === "asc" ? 1 : -1;
//     } else if (sort === "name") {
//       sortOption.name = order === "asc" ? 1 : -1;
//     } else {
//       // Default sort: latest created items first (newest to oldest)
//       sortOption.createdAt = -1;
//     }

//     // Pagination
//     const pageNum = parseInt(page);
//     const limitNum = parseInt(limit);
//     const skip = (pageNum - 1) * limitNum;

//     // Get total count for pagination info
//     const totalProducts = await Product.countDocuments(query);

//     // Fetch products with pagination
//     const products = await Product.find(query)
//       .populate("category")
//       .populate("subCategory")
//       .populate("nestedSubCategory")
//       .sort(sortOption)
//       .skip(skip)
//       .limit(limitNum);

//     // Calculate pagination info
//     const totalPages = Math.ceil(totalProducts / limitNum);
    
//     res.status(200).json({ 
//       message: "Successfully retrieved products", 
//       data: products,
//       pagination: {
//         currentPage: pageNum,
//         totalPages: totalPages,
//         totalProducts: totalProducts,
//         hasNextPage: pageNum < totalPages,
//         hasPrevPage: pageNum > 1,
//         limit: limitNum
//       }
//     });
    
//   } catch (err) {
//     console.error("Error fetching products:", err);
//     res.status(500).json({ error: "Error fetching products" });
//   }
// };


exports.getAllProduct = async (req, res, next) => {
  const {
    search,
    sort,
    order,
    minPrice,
    maxPrice,
    categoryId,
    subCategoryId,
    nestedSubCategoryId,
    isNewArrivals,
    isBestSelling,
    isWatchAndShop,
    showInHomePage,
    page = 1,
    limit = 12,
  } = req.query;
  
  try {
    let query = {};
    
    // Advanced search: trim, collapse whitespace, match name/description, fuzzy/partial
    if (search && typeof search === 'string' && search.trim()) {
      // Clean up search string
      const cleaned = search.trim().replace(/\s+/g, ' ');
      // Fuzzy regex: allow partial matches, ignore case, match anywhere in name or description
      const regex = new RegExp(cleaned.split(' ').join('.*'), 'i');
      query.$or = [
        { name: { $regex: regex } },
        { description: { $regex: regex } }
      ];
    }

    if (isBestSelling === 'true') {
      query.isBestSelling = true;
    }
    if (isNewArrivals === 'true') {
      query.isNewArrivals = true;
    }
    if (isWatchAndShop === 'true') {
      query.isWatchAndShop = true;
    }
    if (showInHomePage === 'true') {
      query.showInHomePage = true;
    }

    // Handle category filtering with hierarchical priority
    if (nestedSubCategoryId && nestedSubCategoryId.trim() !== "") {
      query.nestedSubCategory = nestedSubCategoryId;
    } else if (subCategoryId && subCategoryId.trim() !== "") {
      query.subCategory = subCategoryId;
    } else if (categoryId && categoryId.trim() !== "") {
      query.category = categoryId;
    }

    // Price filtering - using discountedPrice
    if (minPrice || maxPrice) {
      query.discountedPrice = {};
      if (minPrice) {
        query.discountedPrice.$gte = parseInt(minPrice);
      }
      if (maxPrice) {
        query.discountedPrice.$lte = parseInt(maxPrice);
      }
    }

    // Sort products - FIXED for name sorting
    let sortOption = {};
    if (sort === "discountedPrice") {
      sortOption.discountedPrice = order === "asc" ? 1 : -1;
    } else if (sort === "name") {
      // Use collation for case-insensitive sorting
      // This ensures A to Z and Z to A work correctly regardless of case
      sortOption.name = order === "asc" ? 1 : -1;
    } else {
      sortOption.createdAt = -1;
    }

    // Pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination info
    const totalProducts = await Product.countDocuments(query);

    // Build the query with proper collation for string sorting
    let productsQuery = Product.find(query)
      .populate("category")
      .populate("subCategory")
      .populate("nestedSubCategory");
    
    // Apply collation only for name sorting to ensure case-insensitive sorting
    if (sort === "name") {
      productsQuery = productsQuery.collation({ locale: 'en', strength: 2 });
    }
    
    // Apply sorting and pagination
    const products = await productsQuery
      .sort(sortOption)
      .skip(skip)
      .limit(limitNum);

    // Calculate pagination info
    const totalPages = Math.ceil(totalProducts / limitNum);
    
    res.status(200).json({ 
      message: "Successfully retrieved products", 
      data: products,
      pagination: {
        currentPage: pageNum,
        totalPages: totalPages,
        totalProducts: totalProducts,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
        limit: limitNum
      }
    });
    
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ error: "Error fetching products" });
  }
};

// exports.getAllProduct = async (req, res, next) => {
//   const {
//     search,
//     sort,
//     order,
//     minPrice,
//     maxPrice,
//     categoryId,
//     subCategoryId,
//     nestedSubCategoryId,
//     isNewArrivals,
//     isBestSelling,
//     page = 1,
//     limit = 10,
//     isWatchAndShop
//   } = req.query;
  
//   try {
//     let query = {};
    
//     // Search products by name if a search query is provided
//     if (search) {
//       query.name = { $regex: search, $options: "i" };
//     }

//     if (isBestSelling === 'true') {
//       query.isBestSelling = true;
//     }
    
//     if (isNewArrivals === 'true') {
//       query.isNewArrivals = true;
//     }

//         if (isWatchAndShop === 'true') {
//       query.isWatchAndShop = true;
//     }

//     // Handle category filtering with hierarchical priority
//     if (nestedSubCategoryId && nestedSubCategoryId.trim() !== "") {
//       query.nestedSubCategory = nestedSubCategoryId;
//     } else if (subCategoryId && subCategoryId.trim() !== "") {
//       query.subCategory = subCategoryId;
//     } else if (categoryId && categoryId.trim() !== "") {
//       query.category = categoryId;
//     }

//     // Price filtering
//     if (minPrice || maxPrice) {
//       query.discountedPrice = {};
//       if (minPrice) {
//         query.discountedPrice.$gte = parseInt(minPrice);
//       }
//       if (maxPrice) {
//         query.discountedPrice.$lte = parseInt(maxPrice);
//       }
//     }

//     // Sort products
//     let sortOption = {};
//     if (sort === "price") {
//       sortOption.originalPrice = order === "asc" ? 1 : -1;
//     } else if (sort === "name") {
//       sortOption.name = order === "asc" ? 1 : -1;
//     } else {
//       sortOption.createdAt = -1; // Default: newest first
//     }

//     // Pagination
//     const pageNum = parseInt(page);
//     const limitNum = parseInt(limit);
//     const skip = (pageNum - 1) * limitNum;

//     // Get total count for pagination
//     const totalProducts = await Product.countDocuments(query);
//     const totalPages = Math.ceil(totalProducts / limitNum);

//     // Fetch products with pagination
//     const products = await Product.find(query)
//       .populate("category")
//       .populate("subCategory")
//       .populate("nestedSubCategory")
//       .populate("images")
//       .sort(sortOption)
//       .skip(skip)
//       .limit(limitNum);

//     res.status(200).json({ 
//       message: "Successfully retrieved products", 
//       data: products,
//       pagination: {
//         currentPage: pageNum,
//         totalPages: totalPages,
//         totalProducts: totalProducts,
//         limit: limitNum,
//         hasNextPage: pageNum < totalPages,
//         hasPrevPage: pageNum > 1
//       }
//     });
    
//   } catch (err) {
//     console.error("Error fetching products:", err);
//     res.status(500).json({ error: "Error fetching products" });
//   }
// };


exports.deleteProduct = async (req, res, next) => {
  console.log("deleteProduct called for product:", req.params.productId);
  try {
    const product = await Product.findById(req.params.productId);
    
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // ✅ IMPROVED: Delete all associated image files with error handling
    if (product.images && product.images.length > 0) {
      for (const image of product.images) {
        try {
          if (image.coloredImage) {
            const filePath = path.join(__dirname, "../uploads/products", image.coloredImage);
            await deleteFile(filePath);
          }
        } catch (err) {
          console.error(`Error deleting image file ${image.coloredImage}:`, err);
          // Continue with other images
        }
      }
    }

    // Delete video file if exists
    if (product.video) {
      try {
        await deleteVideoFile(product.video);
      } catch (err) {
        console.error(`Error deleting video ${product.video}:`, err);
        // Continue with product deletion
      }
    }

    const deleteProductData = await Product.findByIdAndDelete(req.params.productId);

    res.status(200).json({
      message: "Product deleted successfully",
      data: deleteProductData,
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ error: error.message || "Failed to delete product" });
  }
};

// ✅ IMPROVED: Helper function to delete files - handles errors gracefully
const deleteFile = (filePath) => {
  return new Promise((resolve) => {
    fs.access(filePath, fs.constants.F_OK, (err) => {
      if (err) {
        console.log(`File doesn't exist: ${filePath}`);
        resolve(); // File doesn't exist, resolve anyway
        return;
      }
      
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error(`Error deleting file ${filePath}:`, unlinkErr);
          resolve(); // ✅ FIXED: Resolve instead of reject so operations don't fail
        } else {
          console.log(`Successfully deleted file: ${filePath}`);
          resolve();
        }
      });
    });
  });
};

// ✅ NEW: Synchronous file deletion for critical cleanup
const deleteFileSync = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Successfully deleted file: ${filePath}`);
    }
  } catch (err) {
    console.error(`Error deleting file ${filePath}:`, err);
    // Don't throw, just log
  }
};

exports.deleteProductImages = async (req, res, next) => {
  console.log("deleteProductImages called:", req.params);
  const { productId, imageId: imageIdParam } = req.params;
  const imageId = imageIdParam ? decodeURIComponent(imageIdParam) : undefined;

  // ✅ VALIDATION: Check if IDs are valid
  if (!productId || !imageId) {
    return res.status(400).json({ error: "Product ID and Image ID are required" });
  }

  try {
    const product = await Product.findOne({ _id: productId });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Find image by filename, colorName, or index
    let imageIndex = -1;
    let colorIndex = -1;
    let imagePathToDelete = null;

    // Check if imageId is a number (index)
    if (!isNaN(imageId)) {
      const index = parseInt(imageId);
      if (index >= 0 && index < product.images.length) {
        imageIndex = index;
        const imageObj = product.images[index];
        if (imageObj.coloredImages && Array.isArray(imageObj.coloredImages)) {
          // If it's an array, we need to find which specific image
          if (imageObj.coloredImages.length === 1) {
            imagePathToDelete = imageObj.coloredImages[0];
          }
        } else if (imageObj.coloredImage) {
          imagePathToDelete = imageObj.coloredImage;
        }
      }
    } else {
      // imageId is a filename or colorName - search through all images
      for (let i = 0; i < product.images.length; i++) {
        const img = product.images[i];
        
        // Check if it's a coloredImages array
        if (img.coloredImages && Array.isArray(img.coloredImages)) {
          const fileIndex = img.coloredImages.findIndex(path => 
            path.includes(imageId) || path === imageId
          );
          if (fileIndex !== -1) {
            imageIndex = i;
            colorIndex = fileIndex;
            imagePathToDelete = img.coloredImages[fileIndex];
            break;
          }
        }
        
        // Check if it's a single coloredImage
        if (img.coloredImage && (img.coloredImage.includes(imageId) || img.coloredImage === imageId)) {
          imageIndex = i;
          imagePathToDelete = img.coloredImage;
          break;
        }
        
        // Check by colorName
        if (img.colorName === imageId) {
          imageIndex = i;
          if (img.coloredImages && Array.isArray(img.coloredImages)) {
            // Delete all images for this color
            imagePathToDelete = img.coloredImages;
          } else if (img.coloredImage) {
            imagePathToDelete = img.coloredImage;
          }
          break;
        }
      }
    }

    if (imageIndex === -1) {
      return res.status(404).json({ error: "Image not found in the product" });
    }

    let deletedImage = null;
    
    // Handle deletion based on structure
    if (colorIndex !== -1 && product.images[imageIndex].coloredImages) {
      // Remove single image from coloredImages array
      deletedImage = product.images[imageIndex].coloredImages.splice(colorIndex, 1)[0];
      
      // If no images left for this color, remove the entire color variant
      if (product.images[imageIndex].coloredImages.length === 0) {
        deletedImage = product.images.splice(imageIndex, 1)[0];
      }
    } else {
      // Remove entire color variant
      deletedImage = product.images.splice(imageIndex, 1)[0];
    }
    
    // Delete the actual image file(s) from folder
    const deleteImageFiles = async (paths) => {
      const pathsToDelete = Array.isArray(paths) ? paths : [paths];
      for (const imgPath of pathsToDelete) {
        if (imgPath) {
          try {
            const filePath = path.join(__dirname, "../uploads/products", imgPath);
            await deleteFile(filePath);
          } catch (err) {
            console.error(`Error deleting image file ${imgPath}:`, err);
            // Continue with database deletion
          }
        }
      }
    };
    
    if (imagePathToDelete) {
      await deleteImageFiles(imagePathToDelete);
    }

    await product.save();

    res.status(200).json({ 
      message: "Image deleted successfully",
      data: {
        deletedImage: deletedImage,
        remainingImages: product.images.length
      }
    });
  } catch (error) {
    console.error("Error deleting image:", error);
    res.status(500).json({ error: error.message || "Failed to delete image" });
  }
};

exports.updateProduct = async (req, res, next) => {
  try {
    console.log("Updating product:", req.params.productId);
    console.log("Update files:", req.files);
    console.log("Update body:", req.body);

    const product = await Product.findById(req.params.productId);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // ✅ VALIDATION: Check numeric fields
    if (req.body.price !== undefined && isNaN(parseFloat(req.body.price))) {
      return res.status(400).json({ error: "Price must be a valid number" });
    }
    if (req.body.stockQuantity !== undefined && isNaN(parseInt(req.body.stockQuantity))) {
      return res.status(400).json({ error: "Stock quantity must be a valid number" });
    }

    let images = (product.images || []).map(toRawImage).filter(Boolean);

    const deletedVariantImagesRaw = req.body.deletedVariantImages || req.body.deletedvariantimages;
    if (deletedVariantImagesRaw) {
      try {
        const deletedVariantImages = JSON.parse(
          typeof deletedVariantImagesRaw === "string"
            ? deletedVariantImagesRaw
            : JSON.stringify(deletedVariantImagesRaw)
        );

        const deletedKeys = new Set(
          (Array.isArray(deletedVariantImages) ? deletedVariantImages : [deletedVariantImages])
            .flatMap((value) => {
              const text = String(value || "").trim();
              if (!text) {
                return [];
              }

              const filename = text.split("/").pop() || text;
              return [text, filename];
            })
        );

        if (deletedKeys.size > 0) {
          const retainedImages = [];

          for (const img of images) {
            const oldFiles = Array.isArray(img.coloredImages)
              ? img.coloredImages
              : img.coloredImage
              ? [img.coloredImage]
              : [];

            const keptFiles = [];

            for (const filename of oldFiles) {
              if (deletedKeys.has(filename) || deletedKeys.has(String(filename).split("/").pop() || filename)) {
                try {
                  const filePath = path.join(__dirname, "../uploads/products", filename);
                  await deleteFile(filePath);
                } catch (err) {
                  console.error("Error deleting removed variant image:", err);
                }
              } else {
                keptFiles.push(filename);
              }
            }

            if (keptFiles.length > 0) {
              retainedImages.push({
                colorName: img.colorName,
                coloredImages: keptFiles,
              });
            }
          }

          images = retainedImages;
        }
      } catch (error) {
        return res.status(400).json({ error: "Invalid deletedVariantImages payload" });
      }
    }

    // ✅ Full variant sync from frontend (colors + existing paths + new files)
    const variantsMetaRaw = req.body.variantsMeta || req.body.variantsmeta;

    if (variantsMetaRaw) {
      try {
        const meta = JSON.parse(
          typeof variantsMetaRaw === "string"
            ? variantsMetaRaw
            : JSON.stringify(variantsMetaRaw)
        );
        if (Array.isArray(meta) && meta.length > 0) {
          const newFiles = getUploadedFiles(req.files, "coloredImage");
          const newFilesByColorName = groupUploadedColorFilesByColorName(req.body, newFiles);
          const rebuilt = [];

          const normalizeImageKeys = (values) => {
            const items = Array.isArray(values) ? values : values ? [values] : [];
            return items.flatMap((value) => {
              const text = String(value || "").trim();
              if (!text) {
                return [];
              }

              const filename = text.split("/").pop() || text;
              return [text, filename];
            });
          };

          for (let i = 0; i < meta.length; i++) {
            const slot = meta[i] || {};
            const colorName =
              (slot.color && String(slot.color).trim()) || `Color ${i + 1}`;

            const existingImages = Array.isArray(slot.existingImages)
              ? slot.existingImages.filter(Boolean)
              : slot.existingImage
              ? [slot.existingImage]
              : [];

            const deletedImageKeys = new Set(normalizeImageKeys(slot.deletedImages));
            const retainedExistingImages = existingImages.filter((imagePath) => {
              const filename = String(imagePath).split("/").pop() || String(imagePath);
              return !deletedImageKeys.has(imagePath) && !deletedImageKeys.has(filename);
            });

            const newImagesForColor = newFilesByColorName[colorName] || [];
            if (newImagesForColor.length > 0) {
              retainedExistingImages.push(...newImagesForColor);
            }

            if (retainedExistingImages.length > 0) {
              rebuilt.push({
                colorName,
                coloredImages: retainedExistingImages,
              });
            }
          }

          if (rebuilt.length > 0) {
            const retained = new Set(
              rebuilt.flatMap((img) => img.coloredImages || [])
            );
            for (const old of images) {
              const oldFiles = Array.isArray(old.coloredImages)
                ? old.coloredImages
                : old.coloredImage
                ? [old.coloredImage]
                : [];

              for (const filename of oldFiles) {
                if (!retained.has(filename)) {
                  try {
                    const filePath = path.join(
                      __dirname,
                      "../uploads/products",
                      filename
                    );
                    await deleteFile(filePath);
                  } catch (err) {
                    console.error("Error deleting replaced image:", err);
                  }
                }
              }
            }
            images = rebuilt;
          } else {
            images = [];
          }
        } else if (Array.isArray(meta) && meta.length === 0) {
          for (const old of images) {
            const oldFiles = Array.isArray(old.coloredImages)
              ? old.coloredImages
              : old.coloredImage
              ? [old.coloredImage]
              : [];

            for (const filename of oldFiles) {
              try {
                const filePath = path.join(
                  __dirname,
                  "../uploads/products",
                  filename
                );
                await deleteFile(filePath);
              } catch (err) {
                console.error("Error deleting cleared image file:", err);
              }
            }
          }

          images = [];
        }
      } catch (parseError) {
        return res.status(400).json({ error: "Invalid variantsMeta payload" });
      }
    } else {
      const colorImages = getUploadedFiles(req.files, "coloredImage");
      if (colorImages.length > 0) {
      
      // Get color names - handle multiple formats
      let colorNames = [];
      if (Array.isArray(req.body.colorName)) {
        colorNames = req.body.colorName.filter(name => name && name.trim());
      } else if (typeof req.body.colorName === 'string' && req.body.colorName.trim()) {
        colorNames = [req.body.colorName.trim()];
      }

      // Decide whether to replace or append images
      const replaceImages = req.body.replaceImages === 'true' || req.body.replaceImages === true;
      
      console.log(`Update mode: ${replaceImages ? 'REPLACE' : 'APPEND'} - Adding ${colorImages.length} image(s), ${colorNames.length} color name(s)`);

      if (replaceImages) {
        // ✅ Delete old image files from filesystem
        console.log(`Removing ${images.length} existing image(s)...`);
        if (product.images && product.images.length > 0) {
          for (const img of product.images) {
            const filesToDelete = Array.isArray(img.coloredImages)
              ? img.coloredImages
              : img.coloredImage
              ? [img.coloredImage]
              : [];
            for (const filename of filesToDelete) {
              try {
                const filePath = path.join(__dirname, "../uploads/products", filename);
                deleteFileSync(filePath);
              } catch (err) {
                console.error("Error deleting old image file:", err);
              }
            }
          }
        }
        images = []; // Reset images
      }

      // ✅ Embed new images directly
      const groupedVariants = buildColorVariantImages(colorNames, colorImages);
      for (let i = colorNames.length; i < colorImages.length; i++) {
        if (!colorNames[i]) {
          colorNames[i] = `Color ${i + 1}`;
        }
      }

      try {
        if (groupedVariants.length > 0) {
          if (replaceImages || images.length === 0) {
            images = groupedVariants;
          } else {
            for (const variant of groupedVariants) {
              const existing = images.find((img) => img.colorName === variant.colorName);
              if (existing) {
                existing.coloredImages = [
                  ...(existing.coloredImages || [existing.coloredImage]).filter(Boolean),
                  ...variant.coloredImages,
                ];
                existing.coloredImage = existing.coloredImages[0];
              } else {
                images.push(variant);
              }
            }
          }
        }

        groupedVariants.forEach((variant) => {
          console.log(
            `Added image variant: ${variant.colorName} (${variant.coloredImages.join(", ")})`
          );
        });
        console.log(`✅ Successfully added ${colorImages.length} image(s)`);
      } catch (imageError) {
        // ✅ CLEANUP: Delete any uploaded image files if save fails
        console.error("Error embedding images, cleaning up:", imageError);
        for (const file of colorImages) {
          try {
            const filePath = path.join(__dirname, "../uploads/products", file.filename);
            deleteFileSync(filePath);
          } catch (err) {
            console.error(`Error cleaning up file ${file.filename}:`, err);
          }
        }
        throw imageError;
      }
      } else {
        // ✅ Color-only update: no new files, but colorName values were sent
        const colorNames = parseColorNames(req.body);
        if (colorNames.length > 0 && images.length > 0) {
          images = images.map((img, index) => ({
            colorName:
              colorNames[index] !== undefined && colorNames[index] !== ""
                ? String(colorNames[index]).trim()
                : img.colorName,
            coloredImages: img.coloredImages ||
              (img.coloredImage ? [img.coloredImage] : []),
          }));
          console.log(
            `✅ Updated ${Math.min(colorNames.length, images.length)} variant color(s) without new files`
          );
        }
      }
    }

    // Get video if provided, otherwise keep existing
    let videoFilename = product.video;
    const uploadedVideos = getUploadedFiles(req.files, "video");
    const removeVideo =
      req.body.removeVideo === "true" || req.body.removeVideo === true;

    if (uploadedVideos.length > 0) {
      const uploadedVideo = uploadedVideos[0];
      if (!uploadedVideo.size) {
        return res.status(400).json({ error: "Uploaded video file is empty" });
      }
      videoFilename = uploadedVideo.filename;

      if (product.video && product.video !== videoFilename) {
        try {
          await deleteVideoFile(product.video);
        } catch (err) {
          console.error("Error deleting old video:", err);
        }
      }
    } else if (removeVideo) {
      if (product.video) {
        try {
          await deleteVideoFile(product.video);
        } catch (err) {
          console.error("Error deleting removed video:", err);
        }
      }
      videoFilename = null;
    }

    // ✅ IMPROVED: Update product with new data and validation
    const previousStockQuantity = Number(product.stockQuantity || 0);
    product.name = req.body.name || product.name;
    product.price =
      req.body.price !== undefined ? parseFloat(req.body.price) : product.price;
    product.stockQuantity =
      req.body.stockQuantity !== undefined
        ? parseInt(req.body.stockQuantity)
        : product.stockQuantity;
    product.images = images;
    product.markModified("images");
    product.video = videoFilename;
    product.originalPrice =
      req.body.originalPrice !== undefined
        ? parseFloat(req.body.originalPrice)
        : product.originalPrice;
    product.discountedPrice =
      req.body.discountedPrice !== undefined
        ? parseFloat(req.body.discountedPrice)
        : product.discountedPrice;
    product.category = req.body.category || product.category;
    product.subCategory = req.body.subCategory || product.subCategory;
    product.nestedSubCategory =
      req.body.nestedSubCategory || product.nestedSubCategory || null;
    product.discountPercentage =
      req.body.discountPercentage !== undefined
        ? parseFloat(req.body.discountPercentage)
        : product.discountPercentage;
    product.description = req.body.description || product.description;
    product.isNewArrivals =
      req.body.isNewArrivals !== undefined
        ? req.body.isNewArrivals === "true" || req.body.isNewArrivals === true
        : product.isNewArrivals;
    product.isBestSelling =
      req.body.isBestSelling !== undefined
        ? req.body.isBestSelling === "true" || req.body.isBestSelling === true
        : product.isBestSelling;
    product.isWatchAndShop =
      req.body.isWatchAndShop !== undefined
        ? req.body.isWatchAndShop === "true" || req.body.isWatchAndShop === true
        : product.isWatchAndShop;
    product.showInHomePage =
      req.body.showInHomePage !== undefined
        ? req.body.showInHomePage === "true" || req.body.showInHomePage === true
        : product.showInHomePage;
    product.isHotSelling =
      req.body.isHotSelling !== undefined
        ? req.body.isHotSelling === "true" || req.body.isHotSelling === true
        : product.isHotSelling;

    await product.save();

    // Restock event: the product just came back from out-of-stock → notify
    // everyone who asked to be emailed when it returns (non-blocking).
    if (didRestock(previousStockQuantity, product.stockQuantity)) {
      notifySubscribersOfRestock(product._id).catch((err) =>
        console.error("[Restock] Notification run failed:", err?.message || err)
      );
    }

    const finalProduct = await Product.findById(product._id)
      .populate("category")
      .populate("subCategory")
      .populate("nestedSubCategory");

    res.status(200).json({
      message: `Product updated successfully with ${images.length} total image variant(s)`,
      data: finalProduct,
    });
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({ error: error.message || "Failed to update product" });
  }
};

exports.getProductDetailsById = async (req, res, next) => {
  try {
    const productId = req.params.productId;
    const productDetails = await Product.findById(productId)
      .populate("category")
      .populate("subCategory")
      .populate("nestedSubCategory");

    if (!productDetails) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.status(200).json({
      message: "successfully get Product Details",
      data: productDetails,
    });
  } catch (error) {
    console.log(error, "error");
    res.status(500).json({ error: error.message });
  }
};

exports.productListByCategory = async (req, res, next) => {
  try {
    const categoryId = req.params.categoryId;
    const productListByCategory = await Product.find({
      category: categoryId,
    })
    .populate("category")
    .populate("subCategory")
    .populate("nestedSubCategory");

    if (!productListByCategory || productListByCategory.length === 0) {
      return res
        .status(404)
        .json({ error: "Product not found for this category" });
    }

    res.status(200).json({
      message: "successfully get Products",
      data: productListByCategory,
    });
  } catch (error) {
    console.log(error, "error");
    res.status(500).json({ error: error.message });
  }
};

exports.CreateProductImage = async (req, res, next) => {
  try {
    console.log("CreateProductImage called");
    
    // ✅ VALIDATION: Check if productId is provided
    const { productId } = req.body;
    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }

    // ✅ VALIDATION: Check if files exist
    const colorImages = getUploadedFiles(req.files, "coloredImage");
    if (colorImages.length === 0) {
      return res.status(400).json({ error: "No image files provided" });
    }

    // ✅ Get the product first
    const product = await Product.findById(productId);
    if (!product) {
      // Clean up uploaded files on error
      if (colorImages.length > 0) {
        for (const file of colorImages) {
          try {
            const filePath = path.join(__dirname, "../uploads/products", file.filename);
            deleteFileSync(filePath);
          } catch (err) {
            console.error(`Error deleting file ${file.filename}:`, err);
          }
        }
      }
      return res.status(404).json({ error: "Product not found" });
    }

    console.log(`Processing ${colorImages.length} image(s) for product ${productId}...`);

    // ✅ VALIDATION: Check if colorNames are provided
    let colorNames = [];
    if (Array.isArray(req.body.colorName)) {
      colorNames = req.body.colorName.filter(name => name && name.trim());
    } else if (typeof req.body.colorName === 'string' && req.body.colorName.trim()) {
      colorNames = [req.body.colorName.trim()];
    }

    if (colorNames.length === 0) {
      console.log(`No color names provided, auto-filling for ${colorImages.length} image(s)`);
    } else {
      console.log(`Received ${colorNames.length} color name(s) for ${colorImages.length} image(s)`);
    }

    // ✅ Auto-fill missing color names
    for (let i = colorNames.length; i < colorImages.length; i++) {
      colorNames.push(`Color ${i + 1}`);
    }

    console.log(`Final color names:`, colorNames);

    const addedImages = [];

    try {
      // ✅ Add images directly to the product's images array
      for (let i = 0; i < colorImages.length; i++) {
        const imageObj = {
          colorName: colorNames[i].trim(),
          coloredImage: colorImages[i].filename,
        };
        product.images.push(imageObj);
        addedImages.push(imageObj);
        console.log(`✅ Added: ${colorNames[i]} (${colorImages[i].filename})`);
      }

      // Save the updated product
      await product.save();
      console.log(`✅ Successfully added ${addedImages.length} product image(s) to product ${productId}`);

      res.status(201).json({
        message: `Successfully added ${addedImages.length} product image variant(s)`,
        data: addedImages,
        summary: {
          totalImages: addedImages.length,
          colorNames: colorNames,
          productId: productId,
        },
      });
    } catch (saveError) {
      // ✅ CLEANUP: Delete any uploaded files if save fails
      console.error("Error saving images, cleaning up:", saveError);
      for (const file of colorImages) {
        try {
          const filePath = path.join(__dirname, "../uploads/products", file.filename);
          deleteFileSync(filePath);
        } catch (err) {
          console.error(`Error cleaning up file ${file.filename}:`, err);
        }
      }
      throw saveError;
    }
  } catch (error) {
    console.error("Error creating product images:", error);
    res.status(500).json({ error: error.message || "Failed to create product images" });
  }
};

exports.deleteProductColorVariantImages = async (req, res, next) => {
  const { variantId } = req.params;
  const { productId, imageFilename } = req.body;

  // ✅ VALIDATION: Check if required parameters exist
  if (!variantId) {
    return res.status(400).json({ error: "Variant ID is required" });
  }

  try {
    // Handle two scenarios:
    // 1. If productId is provided in body, delete from specific product
    // 2. If only variantId, treat it as image filename and search all products
    
    let result;
    
    if (productId) {
      // Delete specific image from specific product
      const product = await Product.findById(productId);
      
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      // Find image by filename or index
      let imageIndex = -1;
      let deletedImage = null;

      if (!isNaN(variantId)) {
        // variantId is an index
        imageIndex = parseInt(variantId);
        if (imageIndex >= 0 && imageIndex < product.images.length) {
          deletedImage = product.images[imageIndex];
        }
      } else {
        // variantId is a filename or colorName
        imageIndex = product.images.findIndex(img => 
          img.coloredImage === variantId || img.colorName === variantId
        );
        if (imageIndex !== -1) {
          deletedImage = product.images[imageIndex];
        }
      }

      if (imageIndex === -1 || !deletedImage) {
        return res.status(404).json({ error: "Image not found in the product" });
      }

      // Delete the file
      try {
        const filePath = path.join(__dirname, "../uploads/products", deletedImage.coloredImage);
        await deleteFile(filePath);
      } catch (err) {
        console.error(`Error deleting image file ${deletedImage.coloredImage}:`, err);
        // Continue with array removal
      }

      // Remove from array
      product.images.splice(imageIndex, 1);
      await product.save();

      result = {
        message: "Image variant deleted successfully",
        data: deletedImage,
        productId: productId,
        remainingImages: product.images.length
      };
    } else {
      // Legacy behavior: Search all products for image by filename
      // This maintains backward compatibility
      const products = await Product.find({ 
        "images.coloredImage": variantId 
      });

      if (products.length === 0) {
        return res.status(404).json({ error: "Image variant not found in any product" });
      }

      // Remove from all products that have this image
      let filesDeleted = 0;
      for (const product of products) {
        const imageIndex = product.images.findIndex(img => img.coloredImage === variantId);
        if (imageIndex !== -1) {
          const image = product.images[imageIndex];
          try {
            const filePath = path.join(__dirname, "../uploads/products", image.coloredImage);
            await deleteFile(filePath);
            filesDeleted++;
          } catch (err) {
            console.error(`Error deleting image file:`, err);
          }
          product.images.splice(imageIndex, 1);
          await product.save();
        }
      }

      result = {
        message: `Image variant deleted from ${products.length} product(s)`,
        filesDeleted: filesDeleted,
        productsAffected: products.map(p => p._id)
      };
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("Error deleting variant image:", error);
    res.status(500).json({ error: error.message || "Failed to delete variant image" });
  }
};

exports.getAllProductVariantImages = async (req, res, next) => {
  try {
    // Since images are now embedded in products, aggregate all unique images
    const products = await Product.find({}, { images: 1 }).lean();

    const allImages = [];
    const seenFilenames = new Set();

    for (const product of products) {
      if (product.images && Array.isArray(product.images)) {
        for (const image of product.images) {
          if (image.coloredImage && !seenFilenames.has(image.coloredImage)) {
            allImages.push({
              ...image,
              productId: product._id,
            });
            seenFilenames.add(image.coloredImage);
          }
        }
      }
    }

    res.status(200).json({ 
      message: "Successfully retrieved all product color variants", 
      data: allImages,
      total: allImages.length
    });
  } catch (error) {
    console.error("Error fetching variant images:", error);
    res.status(500).json({ error: error.message });
  }
};


exports.getHotSellingProducts = async (req, res, next) => {
  try {
    const hotSellingProducts = await Product.find({ isHotSelling: true })
      .populate("category")
      .populate("subCategory")
      .populate("nestedSubCategory")
      .sort({ createdAt: -1 });

    res.status(200).json({
      message: "Successfully retrieved hot selling products",
      data: hotSellingProducts,
      count: hotSellingProducts.length
    });
  } catch (error) {
    console.error("Error fetching hot selling products:", error);
    res.status(500).json({ error: "Error fetching hot selling products" });
  }
};

// Add product to hot selling
exports.addToHotSelling = async (req, res, next) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }

    // Find the product
    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Check if already hot selling
    if (product.isHotSelling) {
      return res.status(400).json({ 
        error: "Product is already marked as hot selling" 
      });
    }

    // Update product
    product.isHotSelling = true;
    await product.save();

    res.status(200).json({
      message: "Product successfully added to hot selling",
      data: product
    });
  } catch (error) {
    console.error("Error adding product to hot selling:", error);
    res.status(500).json({ error: error.message });
  }
};

// Remove product from hot selling
exports.removeFromHotSelling = async (req, res, next) => {
  try {
    const { productId } = req.params;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }

    // Find the product
    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Check if it's hot selling
    if (!product.isHotSelling) {
      return res.status(400).json({ 
        error: "Product is not marked as hot selling" 
      });
    }

    // Update product
    product.isHotSelling = false;
    await product.save();

    res.status(200).json({
      message: "Product successfully removed from hot selling",
      data: product
    });
  } catch (error) {
    console.error("Error removing product from hot selling:", error);
    res.status(500).json({ error: error.message });
  }
};

// Bulk update hot selling status (optional - for advanced use)
exports.bulkUpdateHotSelling = async (req, res, next) => {
  try {
    const { productIds, isHotSelling } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ 
        error: "Product IDs array is required" 
      });
    }

    if (typeof isHotSelling !== 'boolean') {
      return res.status(400).json({ 
        error: "isHotSelling must be a boolean value" 
      });
    }

    // Update multiple products
    const result = await Product.updateMany(
      { _id: { $in: productIds } },
      { $set: { isHotSelling: isHotSelling } }
    );

    res.status(200).json({
      message: `Successfully updated ${result.modifiedCount} product(s)`,
      data: {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      }
    });
  } catch (error) {
    console.error("Error bulk updating hot selling status:", error);
    res.status(500).json({ error: error.message });
  }
};

// Ceiling for a single bulk category write. The `all` scope rewrites every
// matching product in one updateMany, so an unbounded catalog-wide request is
// almost always a mis-click rather than an intent worth honouring.
const MAX_BULK_CATEGORY_PRODUCTS = 10000;

// Collapse a client-supplied id into `undefined` when it was omitted, null or
// blank. Without this, `subCategoryId: ""` would read as "provided" and take
// the back-fill/cross-check branches below.
const normalizeBulkParam = (value) => {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
};

// Find the SubCategory that owns a nested sub-category, so a caller that only
// picked the deepest level still gets a coherent parent chain written.
const findOwningSubCategory = async (nestedSubCategoryId) =>
  SubCategory.findOne({ subCategories: nestedSubCategoryId }).select("_id");

// Same idea one level up: which Category owns this SubCategory?
const findOwningCategory = async (subCategoryId) =>
  Category.findOne({ subCategories: subCategoryId }).select("_id");

// Turn the (optional) category / subCategory / nestedSubCategory triple into a
// single coherent set of writes.
//
// Two rules make the result safe to apply with one updateMany:
//   1. Missing parents are back-filled from the database, so picking only a
//      nested sub-category still writes the sub-category and category it
//      actually belongs to.
//   2. A level that is *not* picked and cannot be derived is cleared. Leaving a
//      stale sub-category behind after a category change would point the product
//      at a sub-category of a different category, which no filter in
//      getAllProduct could ever find again.
const resolveCategoryTarget = async ({
  categoryId,
  subCategoryId,
  nestedSubCategoryId,
}) => {
  let nextCategoryId = normalizeBulkParam(categoryId);
  let nextSubCategoryId = normalizeBulkParam(subCategoryId);
  let nextNestedSubCategoryId = normalizeBulkParam(nestedSubCategoryId);

  if (
    !nextCategoryId &&
    !nextSubCategoryId &&
    !nextNestedSubCategoryId
  ) {
    return {
      error: "At least one of categoryId, subCategoryId or nestedSubCategoryId is required",
    };
  }

  // --- existence checks, deepest level first so we can reuse the lookup ---
  let nestedDoc = null;
  if (nextNestedSubCategoryId) {
    if (!mongoose.isValidObjectId(nextNestedSubCategoryId)) {
      return { error: "nestedSubCategoryId is not a valid id" };
    }
    nestedDoc = await SubCategoryNested.findById(nextNestedSubCategoryId).select("_id");
    if (!nestedDoc) {
      return { error: "No nested sub-category found with the given nestedSubCategoryId" };
    }
  }

  let subCategoryDoc = null;
  if (nextSubCategoryId) {
    if (!mongoose.isValidObjectId(nextSubCategoryId)) {
      return { error: "subCategoryId is not a valid id" };
    }
    subCategoryDoc = await SubCategory.findById(nextSubCategoryId).select("_id subCategories");
    if (!subCategoryDoc) {
      return { error: "No sub-category found with the given subCategoryId" };
    }
  } else if (nestedDoc) {
    const owner = await findOwningSubCategory(nestedDoc._id);
    if (!owner) {
      return {
        error: "The selected nested sub-category is not linked to any sub-category",
      };
    }
    nextSubCategoryId = String(owner._id);
    subCategoryDoc = await SubCategory.findById(owner._id).select("_id subCategories");
  }

  let categoryDoc = null;
  if (nextCategoryId) {
    if (!mongoose.isValidObjectId(nextCategoryId)) {
      return { error: "categoryId is not a valid id" };
    }
    categoryDoc = await Category.findById(nextCategoryId).select("_id subCategories");
    if (!categoryDoc) {
      return { error: "No category found with the given categoryId" };
    }
  } else if (subCategoryDoc) {
    const owner = await findOwningCategory(subCategoryDoc._id);
    if (!owner) {
      return {
        error: "The selected sub-category is not linked to any category",
      };
    }
    nextCategoryId = String(owner._id);
    categoryDoc = await Category.findById(owner._id).select("_id subCategories");
  }

  // --- cross-level consistency, only when the caller pinned both ends ---
  if (categoryDoc && subCategoryDoc) {
    const owned = categoryDoc.subCategories.some(
      (id) => String(id) === String(subCategoryDoc._id)
    );
    if (!owned) {
      return {
        error: "The selected sub-category does not belong to the selected category",
      };
    }
  }

  if (subCategoryDoc && nestedDoc) {
    const owned = (subCategoryDoc.subCategories || []).some(
      (id) => String(id) === String(nestedDoc._id)
    );
    if (!owned) {
      return {
        error: "The selected nested sub-category does not belong to the selected sub-category",
      };
    }
  }

  // --- build the write ---
  // categoryDoc is always resolved by now: every accepted path either pinned a
  // category, or supplied a deeper level whose parent chain got back-filled.
  // subCategoryDoc is legitimately null for a category-only change, which is
  // exactly the case that has to clear it.
  const set = {
    category: categoryDoc?._id || null,
    subCategory: subCategoryDoc?._id || null,
    // A sub-category change invalidates the old nested sub-category unless a
    // new one was picked.
    nestedSubCategory: nextNestedSubCategoryId ? nestedDoc?._id || null : null,
  };

  const cleared = nextNestedSubCategoryId
    ? []
    : subCategoryDoc
    ? ["nestedSubCategory"]
    : ["subCategory", "nestedSubCategory"];

  return {
    set,
    cleared,
    // Normalised to null so the response always carries all three keys — an
    // `undefined` would be dropped by JSON.stringify and the client would have
    // to guess whether a missing key means "cleared" or "unchanged".
    categoryId: nextCategoryId || null,
    subCategoryId: nextSubCategoryId || null,
    nestedSubCategoryId: nextNestedSubCategoryId || null,
  };
};

// Rebuild the product filter used by the admin list for the `all` scope, so
// "apply to everything matching" hits exactly the rows the table is showing.
const buildBulkCategoryFilter = (filters = {}) => {
  const query = {};

  const search = normalizeBulkParam(filters.search);
  if (search) {
    const cleaned = search.replace(/\s+/g, " ");
    const regex = new RegExp(cleaned.split(" ").join(".*"), "i");
    query.$or = [{ name: { $regex: regex } }, { description: { $regex: regex } }];
  }

  // Same hierarchical priority as getAllProduct: the most specific filter wins.
  const categoryId = normalizeBulkParam(filters.categoryId);
  const subCategoryId = normalizeBulkParam(filters.subCategoryId);
  const nestedSubCategoryId = normalizeBulkParam(filters.nestedSubCategoryId);

  if (nestedSubCategoryId) {
    query.nestedSubCategory = nestedSubCategoryId;
  } else if (subCategoryId) {
    query.subCategory = subCategoryId;
  } else if (categoryId) {
    query.category = categoryId;
  }

  return query;
};

// Bulk reassign the category hierarchy of many products in one request.
//
// Body:
//   productIds[]         — required when scope is "selected"
//   scope                — "selected" (default) or "all"
//   filters              — the list's own filters, used when scope is "all"
//   categoryId           — optional
//   subCategoryId        — optional
//   nestedSubCategoryId  — optional
//
// At least one of the three ids is required. See resolveCategoryTarget for how
// partial selections are completed and why unpicked deeper levels are cleared.
exports.bulkUpdateProductCategory = async (req, res) => {
  try {
    const {
      productIds,
      scope = "selected",
      filters,
      categoryId,
      subCategoryId,
      nestedSubCategoryId,
    } = req.body || {};

    const targetScope = scope === "all" ? "all" : "selected";

    const target = await resolveCategoryTarget({
      categoryId,
      subCategoryId,
      nestedSubCategoryId,
    });
    if (target.error) {
      return res.status(400).json({ error: target.error });
    }

    let query;

    if (targetScope === "all") {
      query = buildBulkCategoryFilter(filters);

      // Refuse an oversized batch instead of rewriting the whole catalog by
      // accident — the admin has to narrow the filter and try again.
      const matching = await Product.countDocuments(query);
      if (matching === 0) {
        return res.status(200).json({
          success: true,
          matchedCount: 0,
          modifiedCount: 0,
          categoryId: target.categoryId,
          subCategoryId: target.subCategoryId,
          nestedSubCategoryId: target.nestedSubCategoryId,
          clearedFields: target.cleared,
          message: "No products matched. Nothing was updated.",
        });
      }
      if (matching > MAX_BULK_CATEGORY_PRODUCTS) {
        return res.status(400).json({
          error: `That selection matches ${matching} products. Narrow the filter to ${MAX_BULK_CATEGORY_PRODUCTS} or fewer.`,
        });
      }
    } else {
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: "Product IDs array is required" });
      }

      // Drop anything that is not a well-formed ObjectId so one bad value can
      // never take the whole request down with a CastError. Dedup on the raw
      // string first — a Set of ObjectId wrappers would never collapse, since
      // each constructor call yields a distinct reference.
      const ids = [
        ...new Set(
          productIds
            .map((id) => String(id))
            .filter((id) => mongoose.isValidObjectId(id))
        ),
      ].map((id) => new mongoose.Types.ObjectId(id));

      if (ids.length === 0) {
        return res.status(400).json({ error: "No valid product IDs provided" });
      }
      if (ids.length > MAX_BULK_CATEGORY_PRODUCTS) {
        return res.status(400).json({
          error: `Too many products selected. The limit is ${MAX_BULK_CATEGORY_PRODUCTS} at a time.`,
        });
      }

      query = { _id: { $in: ids } };
    }

    const result = await Product.updateMany(query, { $set: target.set });

    res.status(200).json({
      success: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      categoryId: target.categoryId,
      subCategoryId: target.subCategoryId,
      nestedSubCategoryId: target.nestedSubCategoryId,
      clearedFields: target.cleared,
      message:
        result.modifiedCount > 0
          ? `Successfully updated the category for ${result.modifiedCount} product(s)`
          : "The selected products already had that category",
    });
  } catch (error) {
    console.error("Error bulk updating product category:", error);
    res.status(500).json({ error: error.message });
  }
};