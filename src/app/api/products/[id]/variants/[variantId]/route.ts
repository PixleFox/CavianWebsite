import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { updateProductAggregations } from '@lib/product-utils';
import { authenticateRequest } from '@lib/api-utils';
import { productRateLimiter } from '@lib/rate-limiter';

const prisma = new PrismaClient();

// Error messages in Farsi
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  INVALID_TOKEN: 'توکن نامعتبر است.',
  NOT_FOUND: 'محصول یا نوع محصول یافت نشد.',
  INVALID_DATA: 'داده‌های ارسالی معتبر نیستند.',
  DUPLICATE_VARIANT: 'این نوع محصول با این مشخصات قبلاً ثبت شده است.',
  INTERNAL_ERROR: 'خطای سرور. لطفاً بعداً تلاش کنید.'
};

// Helper functions
interface ErrorDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}

const errorResponse = (status: number, message: string, details?: ErrorDetails) => {
  return NextResponse.json(
    { success: false, message, ...(details && { details }) },
    { status, headers: { 'Content-Type': 'application/json' } }
  );
};

const successResponse = <T>(data: T, status = 200) => {
  return NextResponse.json(
    { success: true, data },
    { status, headers: { 'Content-Type': 'application/json' } }
  );
};

// Validation schema for updates (PATCH)
const variantUpdateSchema = z.object({
  size: z.string().min(1, 'اندازه الزامی است').optional(),
  color: z.string().optional().nullable(),
  colorHex: z.string().optional().nullable(),
  price: z.number().min(0, 'قیمت نمی‌تواند منفی باشد').optional(),
  compareAtPrice: z.number().min(0).optional().nullable(),
  costPrice: z.number().min(0).optional(),
  quantity: z.number().min(0, 'تعداد نمی‌تواند منفی باشد').optional(),
  isActive: z.boolean().optional(),
  image: z.string().url().optional().nullable(),
  barcode: z.string().optional(),
  sku: z.string().optional(),
}).partial();

// Removed unused type

// GET /api/products/:id/variants/:variantId - Get a specific variant
export async function GET(
  request: NextRequest,
  context: { params: { id: string; variantId: string } }
) {
  const { id: productId, variantId } = await context.params;
  
  // Apply rate limiting for variant detail
  const rateLimit = await productRateLimiter.detail(request, productId);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    // Authenticate request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    // Find the variant
    const variant = await prisma.variant.findUnique({
      where: { id: variantId, productId },
    });
    
    if (!variant) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    return successResponse(variant);
    
  } catch (error) {
    console.error('Error fetching variant:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// PATCH /api/products/:id/variants/:variantId - Partially update a variant
export async function PATCH(
  request: NextRequest,
  context: { params: { id: string; variantId: string } }
) {
  const { id: productId, variantId } = await context.params;
  
  // Apply rate limiting for variant update
  const rateLimit = await productRateLimiter.updateVariant(
    request, 
    productId, 
    variantId
  );
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  let transaction;
  try {
    const { id: productId, variantId } = await context.params;
    
    // Authenticate request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    // Validate request body
    const body = await request.json();
    const validation = variantUpdateSchema.safeParse(body);
    
    if (!validation.success) {
      console.error('Validation error:', validation.error);
      return errorResponse(400, MESSAGES.INVALID_DATA, validation.error.flatten());
    }
    
    const updateData = validation.data;
    
    // Start a transaction
    transaction = await prisma.$transaction(async (tx) => {
      // Check if variant exists and belongs to the product
      const existingVariant = await tx.variant.findUnique({
        where: { id: variantId, productId },
      });
      
      if (!existingVariant) {
        throw new Error('Variant not found');
      }
      
      // Check for duplicate variant (same size and color) if those fields are being updated
      if (updateData.size || updateData.color !== undefined) {
        const size = updateData.size ?? existingVariant.size;
        const color = updateData.color !== undefined ? updateData.color : existingVariant.color;
        
        const duplicateVariant = await tx.variant.findFirst({
          where: {
            id: { not: variantId },
            productId,
            size,
            color,
          },
        });
        
        if (duplicateVariant) {
          throw new Error('Duplicate variant');
        }
      }
      
      // Prepare update data with proper type
      const { quantity, ...updateDataWithoutQuantity } = updateData;
      const updatePayload: Partial<{
        size?: string;
        color?: string | null;
        colorHex?: string | null;
        price?: number;
        compareAtPrice?: number | null;
        costPrice?: number;
        stock?: number;
        isActive?: boolean;
        image?: string | null;
        barcode?: string;
        sku?: string;
      }> = { ...updateDataWithoutQuantity };
      
      // Map quantity to stock if provided
      if (quantity !== undefined) {
        updatePayload.stock = quantity;
      }
      
      // Update the variant
      const updatedVariant = await tx.variant.update({
        where: { id: variantId },
        data: updatePayload,
      });
      
// Update product's updatedBy with admin ID from auth
await tx.product.update({
  where: { id: productId },
  data: { updatedBy: { connect: { id: auth.adminId } } },
});
      
      return updatedVariant;
    });
    
    // Update product aggregations after transaction
    await updateProductAggregations(productId);
    
    return successResponse(transaction);
    
  } catch (error: unknown) {
    console.error('Error updating variant:', error);
    
    if (error instanceof Error) {
      if (error.message === 'Variant not found') {
        return errorResponse(404, MESSAGES.NOT_FOUND);
      }
      
      if (error.message === 'Duplicate variant') {
        return errorResponse(409, MESSAGES.DUPLICATE_VARIANT);
      }
    }
    
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  } finally {
    if (transaction) {
      await prisma.$disconnect();
    }
  }
}

// PUT /api/products/:id/variants/:variantId - Fully update a variant
export async function PUT(
  request: NextRequest,
  context: { params: { id: string; variantId: string } }
) {
  const { id: productId, variantId } = await context.params;
  
  // Apply rate limiting for variant update
  const rateLimit = await productRateLimiter.updateVariant(
    request, 
    productId, 
    variantId
  );
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  let transaction;
  try {
    const { id: productId, variantId } = await context.params;
    
    // Authenticate request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    // Validate request body
    const body = await request.json();
    const validation = z.object({
      // Required fields
      size: z.string({ required_error: 'اندازه الزامی است' }).min(1, 'اندازه نمی‌تواند خالی باشد'),
      price: z.number({ required_error: 'قیمت الزامی است' }).min(0, 'قیمت نمی‌تواند منفی باشد'),
      quantity: z.number({ required_error: 'تعداد الزامی است' }).min(0, 'تعداد نمی‌تواند منفی باشد'),
      
      // Optional fields with defaults
      color: z.string().nullable().optional(),
      colorHex: z.string().nullable().optional(),
      compareAtPrice: z.number().min(0).nullable().optional(),
      costPrice: z.number().min(0).optional(),
      isActive: z.boolean().default(true),
      image: z.string().url().nullable().optional(),
      barcode: z.string().optional(),
      sku: z.string().optional(),
    }).safeParse(body);
    
    if (!validation.success) {
      console.error('Validation error:', validation.error);
      return errorResponse(400, MESSAGES.INVALID_DATA, validation.error.flatten());
    }
    
    const { quantity, ...variantData } = validation.data;
    
    // Start a transaction
    transaction = await prisma.$transaction(async (tx) => {
      // Check if variant exists and belongs to the product
      const existingVariant = await tx.variant.findUnique({
        where: { id: variantId, productId },
      });
      
      if (!existingVariant) {
        throw new Error('Variant not found');
      }
      
      // Check for duplicate variant (same size and color)
      const duplicateVariant = await tx.variant.findFirst({
        where: {
          id: { not: variantId },
          productId,
          size: variantData.size,
          color: variantData.color,
        },
      });
      
      if (duplicateVariant) {
        throw new Error('Duplicate variant');
      }
      
      // Update the variant with all fields
      const updatedVariant = await tx.variant.update({
        where: { id: variantId },
        data: {
          ...variantData,
          stock: quantity, // Map quantity to stock
        },
      });
      
      // Update product's updatedBy with admin ID from auth
      await tx.product.update({
        where: { id: productId },
        data: { updatedBy: { connect: { id: Number(auth.adminId) } } },
      });
      
      return updatedVariant;
    });
    
    // Update product aggregations after transaction
    await updateProductAggregations(productId);
    
    return successResponse(transaction);
    
  } catch (error: unknown) {
    console.error('Error updating variant:', error);
    
    if (error instanceof Error) {
      if (error.message === 'Variant not found') {
        return errorResponse(404, MESSAGES.NOT_FOUND);
      }
      
      if (error.message === 'Duplicate variant') {
        return errorResponse(409, MESSAGES.DUPLICATE_VARIANT);
      }
    }
    
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  } finally {
    if (transaction) {
      await prisma.$disconnect();
    }
  }
}

// DELETE /api/products/:id/variants/:variantId - Delete a variant
export async function DELETE(
  request: NextRequest,
  context: { params: { id: string; variantId: string } }
) {
  // Await the params object first
  const { id: productId, variantId } = await context.params;
  
  // Apply rate limiting for variant deletion
  const rateLimit = await productRateLimiter.deleteVariant(
    request, 
    productId, 
    variantId
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  
  // Authenticate request
  const auth = await authenticateRequest(request);
  if (!auth.success) {
    return auth.response || errorResponse(401, MESSAGES.UNAUTHORIZED);
  }
  
  let transaction;
  try {
    
    // Start a transaction
    transaction = await prisma.$transaction(async (tx) => {
      // Check if variant exists and belongs to the product
      const existingVariant = await tx.variant.findUnique({
        where: { id: variantId, productId },
      });
      
      if (!existingVariant) {
        throw new Error('Variant not found');
      }
      
      // Delete the variant
      await tx.variant.delete({
        where: { id: variantId },
      });
      
// Update product's updatedBy with admin ID from auth
await tx.product.update({
  where: { id: productId },
  data: { updatedBy: { connect: { id: auth.adminId } } },
});
      
      return true;
    });
    
    // Update product aggregations after transaction
    await updateProductAggregations(productId);
    
    return successResponse({ success: true });
    
  } catch (error: unknown) {
    console.error('Error deleting variant:', error);
    
    if (error instanceof Error && error.message === 'Variant not found') {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  } finally {
    if (transaction) {
      await prisma.$disconnect();
    }
  }
}
