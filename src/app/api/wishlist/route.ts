import { NextRequest, NextResponse } from 'next/server';
import prisma from '@lib/prisma';
import { authenticateRequest } from '@lib/api-utils';
// Simple in-memory rate limiting
const rateLimit = {
  // Store request counts per IP
  requests: new Map<string, { count: number; resetTime: number }>(),
  
  // Check if request is rate limited
  check: (ip: string, limit: number, windowMs: number = 60000) => {
    const now = Date.now();
    const entry = rateLimit.requests.get(ip);

    if (!entry || now > entry.resetTime) {
      // New entry or window has passed, reset counter
      rateLimit.requests.set(ip, { count: 1, resetTime: now + windowMs });
      return false;
    }

    // Increment counter and check limit
    entry.count += 1;
    return entry.count > limit;
  },
};

// Error messages
const errorMessages = {
  UNAUTHORIZED: {
    status: 401,
    error: 'دسترسی غیرمجاز',
    message: 'لطفاً وارد حساب کاربری خود شوید'
  },
  TOO_MANY_REQUESTS: {
    status: 429,
    error: 'تعداد درخواست‌ها بیش از حد مجاز',
    message: 'لطفاً کمی صبر کنید و دوباره تلاش کنید'
  },
  PRODUCT_NOT_FOUND: {
    status: 404,
    error: 'محصول یافت نشد',
    message: 'محصول مورد نظر یافت نشد'
  },
  ITEM_NOT_FOUND: {
    status: 404,
    error: 'آیتم مورد نظر یافت نشد',
    message: 'آیتم مورد نظر در لیست علاقه‌مندی‌های شما وجود ندارد'
  },
  INVALID_INPUT: {
    status: 400,
    error: 'ورودی نامعتبر',
    message: 'لطفاً اطلاعات را به درستی وارد کنید'
  },
  SERVER_ERROR: {
    status: 500,
    error: 'خطای سرور',
    message: 'خطایی در سرور رخ داده است. لطفاً دوباره تلاش کنید.'
  }
} as const;

type ErrorCode = keyof typeof errorMessages;

// Helper functions
function successResponse<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

function errorResponse(code: ErrorCode, details?: string) {
  const { status, ...errorData } = errorMessages[code];
  return NextResponse.json(
    { 
      success: false, 
      error: errorData,
      ...(details && { details })
    }, 
    { status }
  );
}

// GET /api/wishlist - Get user's wishlist
export async function GET(request: NextRequest) {
  try {
    // Rate limiting - 10 requests per minute per IP
    const ip = request.headers.get('x-forwarded-for') || '127.0.0.1';
    if (rateLimit.check(ip, 10)) {
      return errorResponse('TOO_MANY_REQUESTS');
    }

    // Authenticate user
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.userId) {
      console.log('Authentication failed:', { success: authResult.success, userId: authResult.userId });
      return errorResponse('UNAUTHORIZED');
    }
    
    console.log('Authenticated user ID:', authResult.userId);

    // Get wishlist items with product details
    const wishlist = await prisma.wishlist.findMany({
      where: { userId: authResult.userId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            price: true,
            compareAtPrice: true,
            isActive: true,
            isFeatured: true,
            isNew: true,
            mainImage: true,
            images: true,
            category: {
              select: {
                id: true,
                name: true,
                slug: true
              }
            },
            variants: {
              select: {
                id: true,
                size: true,
                price: true,
                stock: true,
                isActive: true,
                image: true
              },
              where: { isActive: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return successResponse(wishlist);
  } catch (error) {
    console.error('Error fetching wishlist:', error);
    return errorResponse('SERVER_ERROR');
  }
}

// POST /api/wishlist - Add item to wishlist
export async function POST(request: NextRequest) {
  try {
    // Rate limiting - 10 requests per minute per IP
    const ip = request.headers.get('x-forwarded-for') || '127.0.0.1';
    if (rateLimit.check(ip, 10)) {
      return errorResponse('TOO_MANY_REQUESTS');
    }

    // Authenticate user
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.userId) {
      console.log('Authentication failed:', { success: authResult.success, userId: authResult.userId });
      return errorResponse('UNAUTHORIZED');
    }
    
    console.log('Authenticated user ID:', authResult.userId);

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse('INVALID_INPUT');
    }

    const { productId } = body;

    // Validate input
    if (!productId || typeof productId !== 'string') {
      return errorResponse('INVALID_INPUT');
    }

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true }
    });

    if (!product) {
      return errorResponse('PRODUCT_NOT_FOUND');
    }

    // Check if item already in wishlist
    const existingItem = await prisma.wishlist.findFirst({
      where: { userId: authResult.userId, productId }
    });

    if (existingItem) {
      return successResponse(
        { message: 'این محصول قبلاً به لیست علاقه‌مندی‌های شما اضافه شده است' },
        200
      );
    }

    // Add to wishlist
    const wishlistItem = await prisma.wishlist.create({
      data: {
        userId: authResult.userId,
        productId
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            price: true,
            compareAtPrice: true,
            isActive: true,
            isFeatured: true,
            isNew: true,
            mainImage: true,
            images: true,
            category: {
              select: {
                id: true,
                name: true,
                slug: true
              }
            },
            variants: {
              select: {
                id: true,
                size: true,
                price: true,
                stock: true,
                isActive: true,
                image: true
              },
              where: { isActive: true }
            }
          }
        }
      }
    });

    return successResponse(wishlistItem, 201);
  } catch (error) {
    console.error('Error adding to wishlist:', error);
    return errorResponse('SERVER_ERROR');
  }
}

// DELETE /api/wishlist/[id] - Remove item from wishlist
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Rate limiting - 10 requests per minute per IP
    const ip = request.headers.get('x-forwarded-for') || '127.0.0.1';
    if (rateLimit.check(ip, 10)) {
      return errorResponse('TOO_MANY_REQUESTS');
    }

    // Authenticate user
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.userId) {
      console.log('Authentication failed:', { success: authResult.success, userId: authResult.userId });
      return errorResponse('UNAUTHORIZED');
    }
    
    console.log('Authenticated user ID:', authResult.userId);

    const { id } = params;

    // Validate input
    if (!id) {
      return errorResponse('INVALID_INPUT');
    }

    // Find and delete wishlist item
    const wishlistItem = await prisma.wishlist.findFirst({
      where: { id, userId: authResult.userId }
    });

    if (!wishlistItem) {
      return errorResponse('ITEM_NOT_FOUND');
    }

    await prisma.wishlist.delete({
      where: { id }
    });

    return successResponse({ success: true });
  } catch (error) {
    console.error('Error removing from wishlist:', error);
    return errorResponse('SERVER_ERROR');
  }
}
