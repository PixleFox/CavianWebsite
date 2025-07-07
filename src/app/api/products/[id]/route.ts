import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { verifyToken } from '../../../../../lib/auth';
import { z } from 'zod';
import { updateProductAggregations } from '@lib/product-utils';
import { generateSKU } from '@lib/sku-utils';
import { generateBarcode } from '@lib/barcode-utils';
import { productRateLimiter } from '@lib/rate-limiter';

type ErrorDetails = Record<string, unknown>;
type ApiResponseData = Record<string, unknown>;

const MESSAGES = {
  // Authentication
  UNAUTHORIZED: 'دسترسی غیرمجاز. لطفاً ابتدا وارد حساب کاربری خود شوید.',
  INVALID_TOKEN: 'توکن احراز هویت نامعتبر است. لطفاً دوباره وارد شوید.',
  
  // Product related
  PRODUCT_NOT_FOUND: 'محصول مورد نظر یافت نشد.',
  PRODUCT_DELETED: 'محصول با موفقیت حذف شد.',
  PRODUCT_DELETE_SUCCESS: 'محصول با موفقیت حذف شد.',
  PRODUCT_UPDATE_SUCCESS: 'اطلاعات محصول با موفقیت به‌روزرسانی شد.',
  PRODUCT_UPDATE_FAILED: 'خطا در به‌روزرسانی اطلاعات محصول.',
  
  // Validation
  INVALID_INPUT: 'اطلاعات ارسالی معتبر نمی‌باشد.',
  MISSING_REQUIRED_FIELDS: 'لطفاً فیلدهای اجباری را پر کنید.',
  
  // Order related
  PRODUCT_HAS_ORDERS: 'امکان حذف محصول دارای سفارش وجود ندارد.',
  
  // Server errors
  INTERNAL_ERROR: 'خطای سرور. لطفاً لحظاتی دیگر مجدداً تلاش کنید.',
  DATABASE_ERROR: 'خطا در ارتباط با پایگاه داده.',
  
  // Category related
  CATEGORY_NOT_FOUND: 'دسته‌بندی مورد نظر یافت نشد.',
  
  // Variant related
  DUPLICATE_SKU: 'کد کالای تکراری. لطفاً کد دیگری انتخاب کنید.',
  VARIANT_VALIDATION_ERROR: 'خطا در اعتبارسنجی اطلاعات تنوع محصول.'
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

// Helper to validate product ID format
function isValidProductId(id: string): boolean {
  // Accept both UUID and numeric IDs
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id) ||
         /^\d+$/.test(id);
}

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
    availableSizes: z.array(z.string()).optional(),
  })).min(1, 'حداقل یک نوع محصول باید وجود داشته باشد')
});

export async function GET(request: NextRequest, { params }: Params) {
  // Apply rate limiting for product detail
  const rateLimit = await productRateLimiter.detail(request, params.id);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
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
      return errorResponse(404, MESSAGES.PRODUCT_NOT_FOUND);
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

export async function PUT(request: NextRequest, { params }: Params) {
  // Apply rate limiting for product update
  const rateLimit = await productRateLimiter.update(request, params.id);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
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
    const errors: string[] = [];

    // List of fields that cannot be directly updated via PUT
    const nonUpdatableFields = [
      'availableSizes',
      'price',
      'totalStock',
      'images',
      'createdAt',
      'updatedAt',
      'createdById',
      'updatedById'
    ];

    // Check for non-updatable fields in the request
    const invalidUpdates = Object.keys(body).filter(field => 
      nonUpdatableFields.includes(field)
    );

    // Add error messages for non-updatable fields
    invalidUpdates.forEach(field => {
      errors.push(`Field '${field}' cannot be directly updated. ` + 
        (field === 'availableSizes' ? 'Update variants instead.' : 
         field === 'price' ? 'Update variant prices instead.' : ''));
    });

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id },
    });

    if (!existingProduct) {
      return errorResponse(404, 'محصول یافت نشد');
    }

    // Only include allowed fields in the update
    const allowedFields = [
      'name', 'slug', 'description', 'type', 'tags', 'gender',
      'compareAtPrice', 'costPrice', 'isActive', 'manageStock',
      'mainImage', 'videoUrl', 'weight', 'dimensions', 'material',
      'isFeatured', 'isNew', 'metaTitle', 'metaDescription', 'categoryId'
    ];

    const updateData: Prisma.ProductUpdateInput = {};
    
    // Process allowed fields with proper typing
    for (const field of allowedFields) {
      if (field in body) {
        if (field === 'categoryId' && body[field]) {
          updateData.category = { connect: { id: body[field] } };
        } else if (field === 'isActive' && body[field] !== undefined) {
          updateData.isActive = Boolean(body[field]);
        } else if (field === 'isFeatured' && body[field] !== undefined) {
          updateData.isFeatured = Boolean(body[field]);
        } else if (field === 'isNew' && body[field] !== undefined) {
          updateData.isNew = Boolean(body[field]);
        } else if (field === 'manageStock' && body[field] !== undefined) {
          updateData.manageStock = Boolean(body[field]);
        } else if (field === 'compareAtPrice' && body[field] !== undefined) {
          updateData.compareAtPrice = new Prisma.Decimal(body[field]);
        } else if (field === 'costPrice' && body[field] !== undefined) {
          updateData.costPrice = new Prisma.Decimal(body[field]);
        } else if (field === 'weight' && body[field] !== undefined) {
          updateData.weight = Number(body[field]);
        } else if (field === 'tags' && Array.isArray(body[field])) {
          updateData.tags = body[field];
        } else if (field === 'dimensions' && body[field] !== undefined) {
          updateData.dimensions = String(body[field]);
        } else if (field === 'material' && body[field] !== undefined) {
          updateData.material = String(body[field]);
        } else if (field === 'videoUrl' && body[field] !== undefined) {
          updateData.videoUrl = body[field] || null;
        } else if (field === 'mainImage' && body[field] !== undefined) {
          updateData.mainImage = body[field] || null;
        } else if (field === 'metaTitle' && body[field] !== undefined) {
          updateData.metaTitle = body[field] || null;
        } else if (field === 'metaDescription' && body[field] !== undefined) {
          updateData.metaDescription = body[field] || null;
        } else if (body[field] !== undefined) {
          // Handle other string fields with type safety
          if (field === 'name' && body[field] !== undefined) {
            updateData.name = String(body[field]);
          } else if (field === 'slug' && body[field] !== undefined) {
            updateData.slug = String(body[field]);
          } else if (field === 'description' && body[field] !== undefined) {
            updateData.description = String(body[field]);
          } else if (field === 'type' && body[field] !== undefined) {
            // Use Prisma's enum handling for ProductType
            updateData.type = { set: body[field] };
          } else if (field === 'gender' && body[field] !== undefined) {
            // Use Prisma's enum handling for Gender
            updateData.gender = body[field] ? { set: body[field] } : { set: null };
          }
        }
      }
    }

    // Always update the updatedBy reference
    updateData.updatedBy = { connect: { id: decoded.adminId } };

    // If no valid fields to update and no errors, return success with warning
    if (Object.keys(updateData).length <= 1 && errors.length === 0) {
      return successResponse({
        message: 'هیچ فیلد معتبری برای به‌روزرسانی یافت نشد',
        updated: false,
        product: existingProduct
      });
    }

    // Start of update operation
    try {
      // Update the product
      await prisma.product.update({
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
          variants: true,
        },
      });

      // Update product aggregations (price, totalStock, availableSizes, etc.)
      await updateProductAggregations(id);

      // Get the updated product with all fields
      const fullProduct = await prisma.product.findUnique({
        where: { id },
        include: {
          category: true,
          variants: true,
        },
      });

      // Prepare response with proper type
      const response: {
        success: boolean;
        message: string;
        updatedFields: string[];
        product: typeof fullProduct;
        warnings?: string[];
      } = {
        success: true,
        message: 'محصول با موفقیت به‌روزرسانی شد',
        updatedFields: Object.keys(updateData).filter(key => key !== 'updatedBy') as string[],
        product: fullProduct,
        ...(errors.length > 0 && { warnings: errors })
      };

      return successResponse(response);
    } catch (error) {
      console.error('Error updating product:', error);
      
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          const field = (error.meta?.target as string[])?.[0];
          const message = field === 'slug' 
            ? 'این آدرس قبلاً استفاده شده است' 
            : 'خطای عدم تکراری بودن فیلدها';
          return errorResponse(409, message, { field });
        }
        if (error.code === 'P2025') {
          return errorResponse(404, 'دسته‌بندی یافت نشد');
        }
      }
      
      return errorResponse(500, 'خطای سرور در به‌روزرسانی محصول');
    }
  } catch (error) {
    console.error('Error in PUT /api/products/[id]:', error);
    return errorResponse(500, 'خطای سرور در پردازش درخواست');
  }
}

export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  // Await the params object first
  const resolvedParams = await context.params;
  const productId = resolvedParams.id;
  
  // Apply rate limiting for product update
  const rateLimit = await productRateLimiter.update(request, productId);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  
  try {
    
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
      where: { id: productId },
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

    // Track changes for each variant
    type VariantUpdateResult = {
      variantId: string | null;
      sku: string;
      changes: Record<string, { from: unknown; to: unknown }>;
      warnings: string[];
      status: 'created' | 'updated' | 'unchanged';
    };
    
    const updateResults: VariantUpdateResult[] = [];

    // Start a transaction to update variants
    const result = await prisma.$transaction(async (tx) => {
      const updatedVariants = [];
      
      for (const variant of variants) {
        const variantResult: VariantUpdateResult = {
          variantId: variant.id || null,
          sku: variant.sku || '',
          changes: {},
          warnings: [],
          status: 'updated'
        };

        // For new variants, generate SKU based on product type and color
        const skuValue = variant.id ? variant.sku : generateSKU(product.type, variant.color);
        
        // Generate barcode for new variants if not provided
        const barcodeValue = variant.barcode || generateBarcode();
        
        // Define variant data with explicit types
        // Create variant data without availableSizes since it's not in the Prisma schema
        const variantData: {
          size: string;
          sku: string;
          barcode: string;
          color: string | null;
          colorHex: string | null;
          price?: number;
          compareAtPrice?: number | null;
          costPrice?: number;
          stock: number;
          isActive: boolean;
        } = {
          size: variant.size,
          sku: skuValue, // Use generated SKU for new variants, existing SKU for updates
          barcode: barcodeValue,
          color: variant.color || null,
          colorHex: variant.colorHex || null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          costPrice: variant.costPrice,
          stock: variant.quantity,
          isActive: variant.isActive,
          // availableSizes is not stored in the variant model
        };

        // Check if variant with this SKU already exists for this product
        const existingVariant = await tx.variant.findFirst({
          where: variant.id 
            ? { id: variant.id, productId: productId }
            : { sku: variant.sku, productId: productId, ...(variant.id ? { id: { not: variant.id } } : {}) }
        });

        if (existingVariant) {
          // Define the fields we want to check for changes
          type FieldToCheck = keyof typeof variantData;
          const fieldsToCheck: FieldToCheck[] = [
            'size', 'sku', 'barcode', 'color', 'colorHex', 'price', 
            'compareAtPrice', 'costPrice', 'stock', 'isActive'
          ];
          
          // Check availableSizes separately since it's not part of the variant model
          if (variant.availableSizes) {
            variantResult.warnings.push('Field availableSizes is not currently saved to the database');
          }
          
          // Compare existing values with new values to detect changes
          const changes: Record<string, { from: unknown; to: unknown }> = {};
          
          // Helper function to compare values
          const valuesAreDifferent = (
            existing: unknown, 
            newVal: unknown
          ): boolean => {
            // Handle undefined/null cases
            if (existing === undefined || newVal === undefined) {
              return existing !== newVal;
            }
            
            // Special handling for arrays
            if (Array.isArray(existing) && Array.isArray(newVal)) {
              const sortedExisting = [...existing].sort();
              const sortedNew = [...newVal].sort();
              return JSON.stringify(sortedExisting) !== JSON.stringify(sortedNew);
            }
            
            // Special handling for numbers to avoid floating point comparison issues
            if (typeof existing === 'number' && typeof newVal === 'number') {
              return Math.abs(existing - newVal) > 0.01;
            }
            
            // Default comparison for other types
            return JSON.stringify(existing) !== JSON.stringify(newVal);
          };
          
          // Check each field for changes
          fieldsToCheck.forEach((field: FieldToCheck) => {
            const existingValue = existingVariant[field as keyof typeof existingVariant];
            const newValue = variantData[field];
            
            if (valuesAreDifferent(existingValue, newValue)) {
              changes[field] = { from: existingValue, to: newValue };
            }
          });

          // If no changes, mark as unchanged
          if (Object.keys(changes).length === 0) {
            variantResult.status = 'unchanged';
            variantResult.warnings.push('No changes detected for this variant');
          } else {
            // Update existing variant
            const updated = await tx.variant.update({
              where: { id: existingVariant.id },
              data: variantData,
            });
            updatedVariants.push(updated);
            variantResult.changes = changes;
            variantResult.status = 'updated';
          }
          
          variantResult.variantId = existingVariant.id;
          variantResult.sku = existingVariant.sku;
        } else {
          // Create new variant
          const created = await tx.variant.create({
            data: {
              ...variantData,
              product: { connect: { id: productId } }
            },
          });
          updatedVariants.push(created);
          variantResult.variantId = created.id;
          variantResult.sku = created.sku;
          variantResult.status = 'created';
          variantResult.changes = Object.keys(variantData).reduce((acc, key) => ({
            ...acc,
            [key]: { from: null, to: variantData[key as keyof typeof variantData] }
          }), {});
        }

        updateResults.push(variantResult);
      }

      // Update product's updatedBy field and recalculate aggregations
      await tx.product.update({
        where: { id: productId },
        data: {
          updatedBy: { connect: { id: decoded.adminId } }
        }
      });

      return { updatedVariants };
    });

    // Update product aggregations after transaction
    await updateProductAggregations(productId);

    // Fetch the full product with all relations for the response
    const fullProduct = await prisma.product.findUnique({
      where: { id: productId },
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

    // Generate summary message
    const updatedCount = updateResults.filter(r => r.status === 'updated').length;
    const createdCount = updateResults.filter(r => r.status === 'created').length;
    const unchangedCount = updateResults.filter(r => r.status === 'unchanged').length;

    let message = '';
    if (createdCount > 0 && updatedCount > 0) {
      message = `${createdCount} مورد ایجاد و ${updatedCount} مورد به‌روزرسانی شد`;
    } else if (createdCount > 0) {
      message = `${createdCount} مورد جدید با موفقیت ایجاد شد`;
    } else if (updatedCount > 0) {
      message = `${updatedCount} مورد با موفقیت به‌روزرسانی شد`;
    } else if (unchangedCount > 0) {
      message = 'تغییری در اطلاعات ایجاد نشد';
    } else {
      message = 'عملیات با موفقیت انجام شد';
    }

    // Add warning if some variants were unchanged
    if (unchangedCount > 0) {
      message += ` (${unchangedCount} مورد بدون تغییر باقی ماند)`;
    }

    return successResponse({
      message,
      product: fullProduct,
      variants: result.updatedVariants,
      summary: {
        total: updateResults.length,
        created: createdCount,
        updated: updatedCount,
        unchanged: unchangedCount,
      },
      details: updateResults.map(result => ({
        variantId: result.variantId,
        sku: result.sku,
        status: result.status,
        changes: result.changes,
        warnings: result.warnings
      }))
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

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  // Await the params object
  const resolvedParams = await params;
  const productId = resolvedParams.id;
  
  console.log('DELETE request received for product ID:', productId);
  
  try {
    // Rate limiting check
    const rateLimit = await productRateLimiter.delete(request, productId);
    if (rateLimit.isRateLimited) {
      console.log('Rate limited:', rateLimit);
      return rateLimit.response;
    }
    
    // Authentication check
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      const cookieHeader = request.headers.get('cookie');
      if (cookieHeader) {
        const cookies = cookieHeader.split(';').reduce((acc: Record<string, string>, cookie) => {
          const [key, value] = cookie.trim().split('=');
          acc[key] = value;
          return acc;
        }, {});
        token = cookies['adminToken'] || null;
      }
    }
    
    if (!token) {
      console.log('No authentication token provided');
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }

    const decoded = verifyToken(token);
    if (!decoded?.adminId) {
      console.log('Invalid or expired token');
      return errorResponse(401, MESSAGES.INVALID_TOKEN);
    }

    // Use the already extracted productId
    console.log('Processing delete for product ID:', productId);

    // Validate the ID format
    if (!productId || !isValidProductId(productId)) {
      console.error('Invalid product ID format:', productId);
      return errorResponse(400, 'شناسه محصول نامعتبر است.');
    }

    // Check if product exists
    console.log('Checking if product exists with ID:', productId);
    let existingProduct;
    try {
      existingProduct = await prisma.product.findUnique({
        where: { id: productId },
        include: {
          variants: {
            select: { id: true }
          },
          _count: {
            select: {
              orderItems: true
            }
          }
        },
      });
      
      console.log('Product lookup result:', existingProduct ? 'Found' : 'Not found');
      if (!existingProduct) {
        console.log('Product not found with ID:', productId);
        return errorResponse(404, MESSAGES.PRODUCT_NOT_FOUND);
      }
    } catch (dbError) {
      console.error('Database error when finding product:', dbError);
      return errorResponse(500, 'خطا در ارتباط با پایگاه داده');
    }

    // Product exists, proceed with deletion
    console.log('Product found, checking for orders...');

    // Check if product has any orders
    if (existingProduct._count.orderItems > 0) {
      return errorResponse(400, MESSAGES.PRODUCT_HAS_ORDERS);
    }

    console.log('Starting transaction for product deletion');
    // Use a transaction to ensure data consistency
    await prisma.$transaction(async (prisma) => {
      // First delete all variants
      if (existingProduct.variants.length > 0) {
        await prisma.variant.deleteMany({
          where: { productId: productId }
        });
      }

      // Then delete the product
      await prisma.product.delete({
        where: { id: productId }
      });
    });

    console.log('Updating product aggregations after deletion');
    try {
      await updateProductAggregations(productId);
      console.log('Product aggregations updated successfully');
    } catch (error) {
      console.error('Error updating aggregations:', error);
      // Continue even if aggregations update fails
    }

    return successResponse({
      message: MESSAGES.PRODUCT_DELETE_SUCCESS,
      productId: productId
    }, 200);
  } catch (error) {
    console.error('Error in DELETE /api/products/[id]:', error);
    
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error('Prisma error code:', error.code);
      
      if (error.code === 'P2025') {
        return errorResponse(404, MESSAGES.PRODUCT_NOT_FOUND);
      }
      if (error.code === 'P2003') {
        return errorResponse(400, 'امکان حذف محصول به دلیل وجود سفارش‌های مرتبط وجود ندارد.');
      }
      
      return errorResponse(500, 'خطای پایگاه داده', { code: error.code });
    }
    
    const errorMessage = error instanceof Error ? error.message : 'خطای ناشناخته';
    console.error('Unexpected error:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR, { error: errorMessage });
  }
}