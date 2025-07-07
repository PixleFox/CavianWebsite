import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { authenticateRequest } from '../../../../../lib/api-utils';

const prisma = new PrismaClient();

// GET /api/admin/list - Get list of admins
// Only accessible by admin users
export async function GET(request: Request) {
  try {
    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return NextResponse.json(
        { success: false, message: 'دسترسی غیر مجاز' }, // Unauthorized
        { status: 401 }
      );
    }

    // Get query parameters for pagination
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '10');
    const skip = (page - 1) * limit;

    // Get admins with pagination
    const [admins, total] = await Promise.all([
      prisma.admin.findMany({
        skip,
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneNumber: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          lastLogoutAt: true,
          createdAt: true,
          updatedAt: true,
          creator: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),
      prisma.admin.count()
    ]);

    return NextResponse.json({
      success: true,
      data: admins,
      pagination: {
        total,
        page,
        totalPages: Math.ceil(total / limit),
        limit
      }
    });

  } catch (error) {
    console.error('Error fetching admins:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور' }, // Server error
      { status: 500 }
    );
  }
}
