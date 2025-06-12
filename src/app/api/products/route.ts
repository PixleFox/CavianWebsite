import { NextResponse } from 'next/server';
import { PrismaClient, ProductType, Prisma } from '@prisma/client';
import { verifyToken } from '../../../../lib/auth';
import { z } from 'zod';

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
  sku: z.string().min(1, 'کد کالا الزامی است'),
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
  price: z.number().positive('Price must be positive'),
  compareAtPrice: z.number().positive().optional(),
  costPrice: z.number().positive().optional(),
  isActive: z.boolean().default(false),
  manageStock: z.boolean().default(true),
  mainImage: z.string().url('Main image must be a valid URL'),
  images: z.array(z.string().url()).optional(),
  videoUrl: z.string().url().optional().or(z.literal('')),
  weight: z.number().int().nonnegative().optional(),
  dimensions: z.string().optional(),
  material: z.string().optional(),
  isFeatured: z.boolean().default(false),
  isNew: z.boolean().default(true),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
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
    if (!token) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: Invalid token format',
          receivedHeader: authHeader
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
        { description: { contains: search, mode: 'insensitive' as const } },
        { sku: { contains: search, mode: 'insensitive' as const } }
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
    if (!token) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'Unauthorized: Invalid token format',
          receivedHeader: authHeader
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

    const {
      sku,
      name,
      slug,
      description,
      type,
      categoryId,
      tags,
      gender,
      price,
      compareAtPrice,
      costPrice,
      isActive,
      manageStock,
      mainImage,
      images = [],
      videoUrl,
      weight,
      dimensions,
      material,
      isFeatured,
      isNew,
      metaTitle,
      metaDescription,
    } = validation.data;

    // Check if SKU is unique
    const existingSku = await prisma.product.findUnique({
      where: { sku },
      select: { id: true },
    });

    if (existingSku) {
      return new NextResponse(
        JSON.stringify({ error: 'SKU already exists' }), 
        { status: 400 }
      );
    }

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

    // Create the product
    const product = await prisma.product.create({
      data: {
        sku,
        name,
        slug,
        description,
        type,
        category: { connect: { id: categoryId } },
        tags,
        gender: gender ? (gender as Gender) : null,
        price,
        compareAtPrice,
        costPrice,
        isActive,
        manageStock,
        mainImage,
        images,
        videoUrl: videoUrl || null,
        weight,
        dimensions,
        material,
        isFeatured,
        isNew,
        metaTitle,
        metaDescription,
        totalStock: 0, // Initialize with 0, will be updated with variants
        createdBy: { connect: { id: decoded.adminId } },
        updatedBy: { connect: { id: decoded.adminId } },
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          }
        },
      },
    });

    return NextResponse.json(product, { status: 201 });
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
