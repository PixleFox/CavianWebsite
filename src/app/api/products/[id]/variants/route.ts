import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { updateProductAggregations } from '@lib/product-utils';
import { generateSKU } from '@lib/sku-utils';
import { generateBarcode } from '@lib/barcode-utils';
import { authenticateRequest } from '@lib/api-utils';
import cacheUtils from '@lib/cache-utils';
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

const successResponse = <T>(
  data: T, 
  status = 200,
  headers: Record<string, string> = {}
) => {
  return NextResponse.json(
    { success: true, data },
    { 
      status, 
      headers: { 
        'Content-Type': 'application/json',
        ...headers
      } 
    }
  );
};

// Validation schemas
const variantCreateSchema = z.object({
  size: z.string().min(1, 'اندازه الزامی است'),
  color: z.string().optional(),
  colorHex: z.string().optional(),
  price: z.number().min(0, 'قیمت نمی‌تواند منفی باشد'),
  compareAtPrice: z.number().min(0).optional().nullable(),
  costPrice: z.number().min(0).optional(),
  quantity: z.number().min(0, 'تعداد نمی‌تواند منفی باشد').default(0),
  isActive: z.boolean().default(true),
  image: z.string().url().optional(),
  barcode: z.string().optional(),
  sku: z.string().optional(),
});

// Removed unused schema and type

// Helper function to fetch variants from database
async function fetchVariants(productId: string, isAuthenticated: boolean) {
  // Verify product exists and is active
  const product = await prisma.product.findUnique({
    where: { 
      id: productId,
      ...(!isAuthenticated ? { isActive: true } : {}) // Only check isActive for non-authenticated users
    },
    select: { id: true },
  });
  
  if (!product) {
    return null;
  }
  
  // Get all variants for the product
  return await prisma.variant.findMany({
    where: { 
      productId,
      ...(!isAuthenticated ? { isActive: true } : {}) // Only show active variants to public
    },
    orderBy: { createdAt: 'asc' },
    select: isAuthenticated ? undefined : {
      // For public access, only return non-sensitive fields
      id: true,
      size: true,
      color: true,
      colorHex: true,
      price: true,
      image: true,
      isActive: true,
      sku: true,
      barcode: true,
      stock: true,
      createdAt: true,
      updatedAt: true
    }
  });
}

// GET /api/products/:id/variants - List all variants for a product (public)
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id: productId } = params;
  
  // Apply rate limiting for listing variants
  const rateLimit = await productRateLimiter.listVariants(request, productId);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    // Check if user is authenticated (for additional data access)
    const authHeader = request.headers.get('authorization');
    const isAuthenticated = authHeader?.startsWith('Bearer ');
    const cacheKey = `variants:${productId}:${isAuthenticated ? 'auth' : 'public'}`;
    
    // Try to get from cache for non-authenticated users
    if (!isAuthenticated) {
      const cachedResponse = await cacheUtils.getCachedData(cacheKey, async () => {
        const variants = await fetchVariants(productId, false);
        return variants || [];
      });
      
      if (cachedResponse && cachedResponse.length > 0) {
        return successResponse(cachedResponse, 200, {
          'X-Cache': 'HIT'
        });
      }
    }
    
    // Fetch from database
    const variants = await fetchVariants(productId, Boolean(isAuthenticated));
    
    if (!variants) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    return successResponse(variants, 200, {
      'X-Cache': 'MISS'
    });
    
  } catch (error) {
    console.error('Error fetching variants:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// POST /api/products/:id/variants - Add a new variant
export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // Apply rate limiting for creating variants
  const rateLimit = await productRateLimiter.createVariant(request, context.params.id);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    const { id: productId } = await Promise.resolve(context.params);
    // Authenticate request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    // Verify product exists and get its type
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, type: true },
    });
    
    if (!product) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    // Validate request body
    const body = await request.json();
    const validation = variantCreateSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse(400, MESSAGES.INVALID_DATA, validation.error.flatten());
    }
    
    const variantData = validation.data;
    
    // Check for duplicate variant (same size and color)
    const existingVariant = await prisma.variant.findFirst({
      where: {
        productId,
        size: variantData.size,
        color: variantData.color || null,
      },
    });
    
    if (existingVariant) {
      return errorResponse(409, MESSAGES.DUPLICATE_VARIANT);
    }
    
    // Generate SKU and barcode if not provided
    const sku = variantData.sku || generateSKU(product.type, variantData.color);
    const barcode = variantData.barcode || generateBarcode();
    
    // Create the variant
    const { quantity, ...variantDataWithoutQuantity } = variantData;
    const variant = await prisma.variant.create({
      data: {
        ...variantDataWithoutQuantity,
        stock: quantity,  // Map quantity to stock
        sku,
        barcode,
        product: { connect: { id: productId } },
      },
    });
    
    // Update product aggregations and clear relevant caches
    await Promise.all([
      updateProductAggregations(productId),
      cacheUtils.revalidateProducts(),
      prisma.product.update({
        where: { id: productId },
        data: { updatedBy: { connect: { id: auth.adminId } } },
      })
    ]);
    
    return successResponse(variant, 201);
    
  } catch (error) {
    console.error('Error creating variant:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}
