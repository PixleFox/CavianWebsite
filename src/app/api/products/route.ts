import { NextResponse } from 'next/server';
import { PrismaClient, ProductType, Prisma } from '@prisma/client';
import { verifyToken } from '../../../../lib/auth';
import { z } from 'zod';
import { updateProductAggregations } from '@lib/product-utils';
import { generateSKU } from '@lib/sku-utils';
import { generateBarcode } from '@lib/barcode-utils';

// Type for Variant creation data
type VariantCreateInput = {
  sku?: string; // Made optional since we generate it
  barcode?: string;
  size?: string;
  color?: string;
  colorHex?: string;
  price: number;
  stock: number;
  isActive?: boolean;
  image?: string;
};

type ErrorDetails = Record<string, unknown>;
type ApiResponseData = Record<string, unknown>;

type Gender = 'MEN' | 'WOMEN' | 'UNISEX' | 'KIDS' | null;

// Error messages in Farsi for better user experience
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  INVALID_TOKEN: 'توکن نامعتبر است.',
  NOT_FOUND: 'منبع درخواستی یافت نشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.',
  CATEGORY_NOT_FOUND: 'دسته بندی یافت نشد.',
  PRODUCT_NOT_FOUND: 'محصول یافت نشد.',
  DUPLICATE_SKU: 'کد کالا تکراری است.',
  DUPLICATE_SLUG: 'آدرس محصول تکراری است.'
} as const;

// Helper function to send error responses with consistent format
export function errorResponse(status: number, message: string, details?: ErrorDetails) {
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

// Helper function to send success responses with consistent format
export function successResponse(data: ApiResponseData, status = 200) {
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

type WhereClause = {
  categoryId?: string;
  type?: ProductType;
  isActive?: boolean;
  isFeatured?: boolean;
  isNew?: boolean;
  OR?: Array<{
    name?: { contains: string; mode: Prisma.QueryMode };
    description?: { contains: string; mode: Prisma.QueryMode };
    sku?: { contains: string; mode: Prisma.QueryMode };
  }>;
};

const prisma = new PrismaClient();

// Input validation schemas
const productCreateSchema = z.object({
  name: z.string().min(1, 'نام محصول الزامی است'),
  slug: z.string().min(1, 'آدرس محصول الزامی است').regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'آدرس محصول باید با حروف کوچک و خط تیره باشد (مثال: محصول-من)'
  ),
  description: z.string().optional(),
  type: z.enum([
    'T_SHIRT', 'HOODIE', 'SWEATSHIRT', 'POLO', 'TANK_TOP', 
    'LONGSLEEVE', 'MUG', 'SOCKS', 'HAT', 'TOTE_BAG', 'ACCESSORY'
  ]),
  categoryId: z.string().uuid(),
  tags: z.array(z.string()).optional(),
  gender: z.enum(['MEN', 'WOMEN', 'UNISEX', 'KIDS']).optional(),
  compareAtPrice: z.number().positive().optional(),
  costPrice: z.number().positive().optional(),
  isActive: z.boolean().default(false),
  manageStock: z.boolean().default(true),
  mainImage: z.string().url('Main image must be a valid URL'),
  videoUrl: z.string().url().optional().or(z.literal('')),
  weight: z.number().int().nonnegative().optional(),
  dimensions: z.string().optional(),
  material: z.string().optional(),
  isFeatured: z.boolean().default(false),
  isNew: z.boolean().default(true),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  variants: z.array(z.object({
    sku: z.string().optional(), // Made optional since we generate it
    barcode: z.string().optional(),
    size: z.string().optional(),
    color: z.string().optional(),
    colorHex: z.string().optional(),
    price: z.number().positive(),
    stock: z.number().int().nonnegative(),
    isActive: z.boolean().default(true),
    image: z.string().url().optional(),
  })).min(1, 'At least one variant is required'),
});

export async function GET(request: Request) {
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
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: No token provided in Authorization header or cookies',
          headers: Object.fromEntries(request.headers.entries())
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const decoded = verifyToken(token);
    console.log('GET Decoded token:', decoded);
    
    if (!decoded || !decoded.adminId) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: Invalid or expired token',
          decoded: decoded
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { searchParams } = new URL(request.url);
    
    // Build filter object
    const where: WhereClause = {};
    
    // Add filters from query params
    const categoryId = searchParams.get('categoryId');
    if (categoryId) where.categoryId = categoryId;
    
    const type = searchParams.get('type') as ProductType | null;
    if (type) where.type = type;
    
    const isActive = searchParams.get('isActive');
    if (isActive !== null) where.isActive = isActive === 'true';
    
    const isFeatured = searchParams.get('isFeatured');
    if (isFeatured !== null) where.isFeatured = isFeatured === 'true';
    
    const isNew = searchParams.get('isNew');
    if (isNew !== null) where.isNew = isNew === 'true';
    
    const search = searchParams.get('search');
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } }
      ];
    }

    // Pagination
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '10');
    const skip = (page - 1) * limit;

    // Get total count for pagination
    const total = await prisma.product.count({ where });
    
    // Get products with pagination and relations
    const products = await prisma.product.findMany({
      where,
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          }
        },
        variants: true,
        _count: {
          select: {
            variants: true
          }
        }
      },
      skip,
      take: limit,
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json({
      data: products,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

export async function POST(request: Request) {
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
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: No token provided in Authorization header or cookies',
          headers: Object.fromEntries(request.headers.entries())
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const decoded = verifyToken(token);
    console.log('Decoded token:', decoded);
    
    if (!decoded || !decoded.adminId) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: Invalid or expired token',
          decoded: decoded
        }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate request body
    const body = await request.json();
    const validation = productCreateSchema.safeParse(body);
    
    if (!validation.success) {
      return new NextResponse(
        JSON.stringify({ errors: validation.error.flatten() }), 
        { status: 400 }
      );
    }

    // Destructure the data we need
    const { variants, categoryId, slug, ...productData } = validation.data;

    // Check if slug is unique
    const existingSlug = await prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (existingSlug) {
      return new NextResponse(
        JSON.stringify({ error: 'Slug already exists' }), 
        { status: 400 }
      );
    }

    // Check if category exists
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      return new NextResponse(
        JSON.stringify({ error: 'Category not found' }), 
        { status: 404 }
      );
    }

    // Generate timestamp ID (YYYYMMDDHHMMSS)
    const now = new Date();
    const timestampId = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0')
    ].join('');

    // Prepare base product data
    const productDataInput: Prisma.ProductCreateInput = {
      id: timestampId,
      name: productData.name,
slug,
      description: productData.description || undefined,
      type: productData.type,
      category: { connect: { id: categoryId } },
      tags: productData.tags || [],
      gender: productData.gender ? (productData.gender as Gender) : null,
      price: new Prisma.Decimal(0), // Will be updated by updateProductAggregations
      compareAtPrice: productData.compareAtPrice ? new Prisma.Decimal(productData.compareAtPrice) : null,
      costPrice: productData.costPrice ? new Prisma.Decimal(productData.costPrice) : null,
      isActive: false, // Will be updated by updateProductAggregations
      manageStock: productData.manageStock ?? true,
      mainImage: '', // Temporary empty string, will be updated by updateProductAggregations
      images: [], // Will be updated by updateProductAggregations
      videoUrl: productData.videoUrl || null,
      weight: productData.weight || null,
      dimensions: productData.dimensions || null,
      material: productData.material || null,
      isFeatured: productData.isFeatured ?? false,
      isNew: productData.isNew ?? true,
      metaTitle: productData.metaTitle || null,
      metaDescription: productData.metaDescription || null,
      totalStock: 0, // Will be updated by updateProductAggregations
      availableSizes: [], // Will be updated by updateProductAggregations
      createdBy: { connect: { id: decoded.adminId } },
      updatedBy: { connect: { id: decoded.adminId } },
    };

    // Create the product with variants in a transaction
    const [product] = await prisma.$transaction([
      prisma.product.create({
        data: {
          ...productDataInput,
          variants: {
            create: variants.map((v: VariantCreateInput, index: number) => {
              // Generate SKU based on product type and color
              const generatedSKU = generateSKU(productData.type, v.color);
              
              // Generate barcode if not provided
              const barcode = v.barcode || generateBarcode();
              
              return {
                id: `${timestampId}-${index}`, // Unique ID based on product timestamp and index
                sku: generatedSKU,
                barcode,
                size: v.size || null,
                color: v.color || null,
                colorHex: v.colorHex || null,
                price: v.price ? new Prisma.Decimal(v.price) : new Prisma.Decimal(0),
                stock: v.stock || 0,
                isActive: v.isActive ?? true,
                image: v.image || null,
              };
            }),
          },
        },
        include: {
          category: {
            select: {
              id: true,
              name: true,
              slug: true,
            }
          },
          variants: true,
        },
      })
    ]);

    // Update product aggregations based on variants
    await updateProductAggregations(product.id);

    // Fetch the full product with all relations for the response
    const fullProduct = await prisma.product.findUnique({
      where: { id: product.id },
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

    return NextResponse.json(fullProduct, { status: 201 });
  } catch (error) {
    console.error('Error creating product:', error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const meta = error.meta as { target?: string[] } | undefined;
        const field = meta?.target?.[0];
        const message = field === 'sku' ? MESSAGES.DUPLICATE_SKU : 
                        field === 'slug' ? MESSAGES.DUPLICATE_SLUG : 
                        MESSAGES.INTERNAL_ERROR;
        return errorResponse(409, message, { field, code: error.code });
      }
      if (error.code === 'P2025') {
        return errorResponse(404, MESSAGES.CATEGORY_NOT_FOUND);
      }
    } else if (error instanceof z.ZodError) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        errors: error.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message
        }))
      });
    }
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}