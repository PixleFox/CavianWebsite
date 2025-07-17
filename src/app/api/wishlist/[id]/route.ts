import { NextRequest, NextResponse } from 'next/server';
import prisma from '@lib/prisma';
import { authenticateRequest } from '@lib/api-utils';
import { rateLimitMiddleware } from '@lib/rate-limiter';

// Error messages
const errorMessages = {
  UNAUTHORIZED: {
    status: 401,
    error: 'دسترسی غیرمجاز',
    message: 'لطفاً وارد حساب کاربری خود شوید'
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

// DELETE /api/wishlist/[id] - Remove item from wishlist
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitMiddleware(
      request,
      `wishlist:delete:${params.id}`,
      'user',
      'delete'
    );
    
    if (rateLimitResult.isRateLimited) {
      return rateLimitResult.response;
    }

    // Authenticate user
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.userId) {
      console.log('Authentication failed:', { success: authResult.success, userId: authResult.userId });
      return errorResponse('UNAUTHORIZED');
    }

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

    return successResponse({ success: true, message: 'آیتم با موفقیت از لیست علاقه‌مندی‌ها حذف شد' });
  } catch (error) {
    console.error('Error removing from wishlist:', error);
    return errorResponse('SERVER_ERROR');
  }
}
