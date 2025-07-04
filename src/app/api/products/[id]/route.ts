import { NextResponse } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { verifyToken } from '../../../../../lib/auth';
import { z } from 'zod';
import { updateProductAggregations } from '@lib/product-utils';
import { generateSKU } from '@lib/sku-utils';
import { generateBarcode } from '@lib/barcode-utils';

type ErrorDetails = Record<string, unknown>;
type ApiResponseData = Record<string, unknown>;

const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  INVALID_TOKEN: 'توکن نامعتبر است.',
  NOT_FOUND: 'محصول یافت نشد.',
  PRODUCT_NOT_FOUND: 'محصول یافت نشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.',
  CATEGORY_NOT_FOUND: 'دسته بندی یافت نشد.',
  DUPLICATE_SKU: 'کد کالا تکراری است.'
} as const;

function errorResponse(status: number, message: string, details?: ErrorDetails) {
  return NextResponse.json(
    { 
      success: false,
      message,
      ...(details && { details }) 
    },
    { 
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
}

function successResponse(data: ApiResponseData, status = 200) {
  return NextResponse.json(
    { 
      success: true,
      data 
    },
    { 
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
}

const prisma = new PrismaClient();

type Params = {
  params: {
    id: string;
  };
};

// Schema for updating product variants
const updateVariantsSchema = z.object({
  variants: z.array(z.object({
    id: z.string().optional(),
    size: z.string().min(1, 'اندازه الزامی است'),
    sku: z.string().min(1, 'کد کالا الزامی است'),
    barcode: z.string().optional(),
    color: z.string().optional(),
    colorHex: z.string().optional(),
    price: z.number().min(0, 'قیمت نمی‌تواند منفی باشد').optional(),
    compareAtPrice: z.number().min(0).optional().nullable(),
    costPrice: z.number().min(0).optional(),
    quantity: z.number().min(0, 'تعداد نمی‌تواند منفی باشد').default(0),
    isActive: z.boolean().default(true),
  })).min(1, 'حداقل یک نوع محصول باید وجود داشته باشد')
});

export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = params;
    
    // Check for token in Authorization header first
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      // Check for token in cookies
      const cookieHeader = request.headers.get('cookie');
      if (cookieHeader) {
        const cookies = Object.fromEntries(
          cookieHeader.split(';').map(c => {
            const [key, ...values] = c.trim().split('=');
            return [key, values.join('=')];
          })
        );
        token = cookies['adminToken'] || null;
      }
    }
    
    if (!token) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    const decoded = await verifyToken(token);
    if (!decoded?.adminId) {
      return errorResponse(401, MESSAGES.INVALID_TOKEN);
    }

    // Get the product with related data including variants
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        variants: {
          select: {
            id: true,
            size: true,
            sku: true,
            barcode: true,
            price: true,
            stock: true,
            isActive: true,
            image: true,
          },
          where: { isActive: true }
        },
        clothingAttributes: true,
        mugAttributes: true,
        accessoryAttributes: true,
        sizeGuide: true,
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    if (!product) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }

    // Return the product with its availableSizes
    return successResponse({
      ...product,
      availableSizes: product.availableSizes || []
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    // Debug: Log all headers and cookies
    console.log('PUT Request Headers:', Object.fromEntries(request.headers.entries()));
    
    // Check for token in Authorization header first
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    console.log('PUT Auth Header:', authHeader);
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      // Check for token in cookies
      const cookieHeader = request.headers.get('cookie');
      console.log('PUT Cookie Header:', cookieHeader);
      
      if (cookieHeader) {
        const cookies = cookieHeader.split(';').reduce((acc: Record<string, string>, cookie) => {
          const [key, value] = cookie.trim().split('=');
          acc[key] = value;
          return acc;
        }, {});
        
        token = cookies['adminToken'] || null;
        console.log('Extracted token from cookies:', token ? 'Token found' : 'No token found');
      }
    }
    
    if (!token) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: No token provided in Authorization header or cookies',
          headers: Object.fromEntries(request.headers.entries())
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const decoded = verifyToken(token);
    console.log('PUT Decoded token:', decoded);
    
    if (!decoded || !decoded.adminId) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: Invalid or expired token',
          decoded: decoded
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { id } = params;
    const body = await request.json();

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id },
    });

    if (!existingProduct) {
      return new NextResponse('Product not found', { status: 404 });
    }

    // Update only allowed fields, excluding derived fields (price, totalStock, images, availableSizes)
    const updateData: Prisma.ProductUpdateInput = {
      name: body.name,
      slug: body.slug,
      description: body.description,
      type: body.type,
      tags: body.tags,
      gender: body.gender,
      compareAtPrice: body.compareAtPrice,
      costPrice: body.costPrice,
      isActive: body.isActive,
      manageStock: body.manageStock,
      mainImage: body.mainImage,
      videoUrl: body.videoUrl,
      weight: body.weight,
      dimensions: body.dimensions,
      material: body.material,
      isFeatured: body.isFeatured,
      isNew: body.isNew,
      metaTitle: body.metaTitle,
      metaDescription: body.metaDescription,
      category: body.categoryId ? { connect: { id: body.categoryId } } : undefined,
      updatedBy: { connect: { id: decoded.adminId } },
    };

    // Update the product
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData,
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return NextResponse.json(updatedProduct);
  } catch (error) {
    console.error('Error updating product:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = params;
    
    // Check for token in Authorization header first
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      // Check for token in cookies
      const cookieHeader = request.headers.get('cookie');
      if (cookieHeader) {
        const cookies = Object.fromEntries(
          cookieHeader.split(';').map(c => {
            const [key, ...values] = c.trim().split('=');
            return [key, values.join('=')];
          })
        );
        token = cookies['adminToken'] || null;
      }
    }
    
    if (!token) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    const decoded = await verifyToken(token);
    if (!decoded?.adminId) {
      return errorResponse(401, MESSAGES.INVALID_TOKEN);
    }

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id },
      include: { variants: true }
    });

    if (!product) {
      return errorResponse(404, MESSAGES.PRODUCT_NOT_FOUND);
    }

    // Parse and validate request body
    const body = await request.json();
    const validation = updateVariantsSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        errors: validation.error.errors.map((e) => ({
          path: Array.isArray(e.path) ? e.path.join('.') : String(e.path),
          message: e.message
        }))
      });
    }

    const { variants } = validation.data;

    // Start a transaction to update variants
    const result = await prisma.$transaction(async (tx) => {
      // Create or update each variant
      const updatedVariants = [];
      
      for (const variant of variants) {
        // For new variants, generate SKU based on product type and color
        // For existing variants, keep the existing SKU
        const sku = variant.id ? variant.sku : generateSKU(product.type, variant.color);
        
        // Generate barcode for new variants if not provided
        const barcode = variant.barcode || generateBarcode();
        
        const variantData = {
          size: variant.size,
          sku, // Use generated SKU for new variants, existing SKU for updates
          barcode,
          color: variant.color || null,
          colorHex: variant.colorHex || null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          costPrice: variant.costPrice,
          stock: variant.quantity,
          isActive: variant.isActive,
        };

        // Check if variant with this SKU already exists for this product
        const existingVariant = await tx.variant.findFirst({
          where: variant.id 
            ? { id: variant.id, productId: id }
            : { sku: variant.sku, productId: id, ...(variant.id ? { id: { not: variant.id } } : {}) }
        });

        if (existingVariant) {
          // Update existing variant
          const updated = await tx.variant.update({
            where: { id: existingVariant.id },
            data: variantData,
          });
          updatedVariants.push(updated);
        } else {
          // Create new variant
          const created = await tx.variant.create({
            data: {
              ...variantData,
              product: { connect: { id } }
            },
          });
          updatedVariants.push(created);
        }
      }

      // Update product's updatedBy field and recalculate aggregations
      await tx.product.update({
        where: { id },
        data: {
          updatedBy: { connect: { id: decoded.adminId } }
        }
      });

      return { updatedVariants };
    });

    // Update product aggregations after transaction
    await updateProductAggregations(id);

    // Fetch the full product with all relations for the response
    const fullProduct = await prisma.product.findUnique({
      where: { id },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          }
        },
        variants: true,
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          }
        },
        updatedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          }
        },
      },
    });

    return successResponse({
      message: 'انواع محصول با موفقیت به‌روزرسانی شدند',
      product: fullProduct,
      variants: result.updatedVariants
    });
  } catch (error) {
    console.error('Error updating product variants:', error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return errorResponse(409, 'کد کالا تکراری است');
      }
      if (error.code === 'P2025') {
        return errorResponse(404, MESSAGES.PRODUCT_NOT_FOUND);
      }
    }
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    // Debug: Log all headers and cookies
    console.log('DELETE Request Headers:', Object.fromEntries(request.headers.entries()));
    
    // Check for token in Authorization header first
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    console.log('DELETE Auth Header:', authHeader);
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      // Check for token in cookies
      const cookieHeader = request.headers.get('cookie');
      console.log('DELETE Cookie Header:', cookieHeader);
      
      if (cookieHeader) {
        const cookies = cookieHeader.split(';').reduce((acc: Record<string, string>, cookie) => {
          const [key, value] = cookie.trim().split('=');
          acc[key] = value;
          return acc;
        }, {});
        
        token = cookies['adminToken'] || null;
        console.log('Extracted token from cookies:', token ? 'Token found' : 'No token found');
      }
    }
    
    if (!token) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: No token provided in Authorization header or cookies',
          headers: Object.fromEntries(request.headers.entries())
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const decoded = verifyToken(token);
    console.log('DELETE Decoded token:', decoded);
    
    if (!decoded || !decoded.adminId) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: Invalid or expired token',
          decoded: decoded
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { id } = params;

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id },
    });

    if (!existingProduct) {
      return new NextResponse('Product not found', { status: 404 });
    }

    // Delete the product (Prisma will handle cascading deletes)
    await prisma.product.delete({
      where: { id },
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error('Error deleting product:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}