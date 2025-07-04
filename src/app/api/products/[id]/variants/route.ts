import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { updateProductAggregations } from '@lib/product-utils';
import { generateSKU } from '@lib/sku-utils';
import { generateBarcode } from '@lib/barcode-utils';
import { authenticateRequest } from '@lib/api-utils';

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

// GET /api/products/:id/variants - List all variants for a product
export async function GET(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    // Authenticate request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse(401, MESSAGES.UNAUTHORIZED);
    }

    const { id } = await Promise.resolve(context.params);
    
    // Verify product exists
    const product = await prisma.product.findUnique({
      where: { id },
      select: { id: true },
    });
    
    if (!product) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    // Get all variants for the product
    const variants = await prisma.variant.findMany({
      where: { productId: id },
      orderBy: { createdAt: 'asc' },
    });
    
    return successResponse(variants);
    
  } catch (error) {
    console.error('Error fetching variants:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// POST /api/products/:id/variants - Add a new variant
export async function POST(
  request: Request,
  context: { params: { id: string } }
) {
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
    
    // Update product aggregations
    await updateProductAggregations(productId);
    
    // Update product's updatedBy
    await prisma.product.update({
      where: { id: productId },
      data: { updatedBy: { connect: { id: auth.adminId } } },
    });
    
    return successResponse(variant, 201);
    
  } catch (error) {
    console.error('Error creating variant:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}
