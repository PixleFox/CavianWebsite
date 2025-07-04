import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export async function updateProductAggregations(productId: string) {
  // Get all active variants for the product
  const variants = await prisma.variant.findMany({
    where: { 
      productId,
      isActive: true 
    },
    select: {
      price: true,
      stock: true,
      size: true,
      image: true,
      isActive: true
    }
  });

  const updateData: Prisma.ProductUpdateInput = {
    updatedAt: new Date()
  };

  if (variants.length === 0) {
    // No active variants, set defaults
    updateData.price = new Prisma.Decimal(0);
    updateData.totalStock = 0;
    updateData.availableSizes = [];
    updateData.images = [];
    updateData.isActive = false;
    updateData.mainImage = undefined; // Use undefined instead of null to unset the field
  } else {
    // Calculate aggregations
    const activeVariants = variants.filter(v => v.isActive);
    const prices = activeVariants
      .map(v => v.price)
      .filter((p): p is Prisma.Decimal => p !== null);
      
    const totalStock = activeVariants.reduce((sum, v) => sum + (v.stock || 0), 0);
    const sizes = Array.from(
      new Set(activeVariants.map(v => v.size).filter((s): s is string => !!s))
    );
    
    const variantImages = activeVariants
      .map(v => v.image)
      .filter((img): img is string => !!img);
      
    const images = Array.from(new Set(variantImages));
    const minPrice = prices.length > 0 
      ? Prisma.Decimal.min(...prices) 
      : new Prisma.Decimal(0);

    // Set update data
    updateData.price = minPrice;
    updateData.totalStock = totalStock;
    updateData.availableSizes = sizes;
    updateData.images = images;
    updateData.isActive = activeVariants.length > 0;
    
    // Only set mainImage if we have images
    if (variantImages.length > 0) {
      updateData.mainImage = variantImages[0];
    } else {
      updateData.mainImage = undefined;
    }
  }

  // Update the product with calculated values
  return prisma.product.update({
    where: { id: productId },
    data: updateData
  });
}

// Update all products' aggregations (for migration purposes)
export async function updateAllProductsAggregations() {
  const products = await prisma.product.findMany({
    select: { id: true }
  });

  for (const product of products) {
    await updateProductAggregations(product.id);
  }
}
