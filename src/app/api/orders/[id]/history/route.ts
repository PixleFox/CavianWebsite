import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { authenticateRequest } from '../../../../../../lib/api-utils';
import { rateLimitMiddleware } from '../../../../../../lib/rate-limiter';

// Error messages in Farsi
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  FORBIDDEN: 'شما مجوز دسترسی به این منبع را ندارید.',
  NOT_FOUND: 'سفارش یافت نشد.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.'
} as const;

// Helper functions for consistent responses
function errorResponse(status: number, message: string, details?: Record<string, unknown>) {
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

function successResponse(data: Record<string, unknown>, status = 200) {
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

// Helper to get user from request
async function getAuthenticatedUser(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success || !auth.adminId) return null;
  
  return await prisma.admin.findUnique({
    where: { id: auth.adminId },
    select: { id: true, role: true, email: true }
  });
}

// GET /api/orders/[id]/history - Get order history
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  // Apply rate limiting
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    `orders:history:${params.id}`,
    'user' // Use 'user' rate limit for order history
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    // Authentication
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    const orderId = params.id;
    
    // Check if user has access to this order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true }
    });
    
    if (!order) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    // Only allow admins or the order owner to view history
    const isAdmin = ['OWNER', 'MANAGER', 'OPERATOR'].includes(user.role);
    if (!isAdmin && order.userId !== user.id) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }
    
    // Get order history with user details, ordered by most recent first
    const history = await prisma.orderHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      take: 100, // Limit the number of history entries to prevent abuse
      select: {
        id: true,
        status: true,
        comment: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });
    
    return successResponse({ history });
    
  } catch (error) {
    console.error('Error fetching order history:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR, { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}

// Internal function to add history entries (not exposed via API)
// This would be used by other API endpoints to record changes
export async function addOrderHistoryEntry(
  orderId: string,
  status: OrderStatus,
  comment: string,
  userId: number
) {
  try {
    await prisma.orderHistory.create({
      data: {
        orderId,
        userId,
        status,
        comment
      }
    });
    return true;
  } catch (error) {
    console.error('Error adding order history:', error);
    return false;
  }
}

// Explicitly handle unsupported methods
export async function POST() {
  return errorResponse(405, 'Method not allowed');
}

export async function PUT() {
  return errorResponse(405, 'Method not allowed');
}

export async function DELETE() {
  return errorResponse(405, 'Method not allowed');
}

// This file uses Next.js 13+ route handlers with named exports for each HTTP method
// GET, POST, PUT, DELETE are already exported above
