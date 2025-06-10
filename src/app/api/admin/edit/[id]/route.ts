import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import { handleError, Errors } from '../../../../../../lib/error-handler';
import { SuccessMessages } from '../../../../../../lib/success-messages';
import { verifyToken } from '../../../../../../lib/auth';

// Add OPTIONS handler for CORS preflight
const OPTIONS = async () => {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Allow': 'PATCH, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
};

export { OPTIONS };

const editAdminSchema = z.object({
  firstName: z.string().min(2, 'نام حداقل باید 2 کاراکتر باشد').optional(),
  lastName: z.string().min(2, 'نام خانوادگی حداقل باید 2 کاراکتر باشد').optional(),
  role: z.enum(['OWNER', 'MANAGER', 'SELLER', 'MARKETER', 'OPERATOR']).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return OPTIONS();
  }

  if (request.method !== 'PATCH') {
    return new NextResponse(
      JSON.stringify({ success: false, error: 'متد درخواست معتبر نیست' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const adminId = parseInt(params.id, 10);
  if (isNaN(adminId)) {
    throw Errors.validation('شناسه ادمین معتبر نیست');
  }
  try {
    // Verify authentication
    const token = request.cookies.get('adminToken')?.value;
    if (!token) throw Errors.authorization('دسترسی غیرمجاز');
    
    const decoded = verifyToken(token);
    if (!decoded) throw Errors.authorization('توکن نامعتبر است');
    
    // Get requester info
    const requester = await prisma.admin.findUnique({ 
      where: { id: decoded.adminId } 
    });
    
    if (!requester) throw Errors.authorization('ادمین معتبر یافت نشد');
    
    // Check permissions
    if (['SELLER', 'MARKETER', 'OPERATOR'].includes(requester.role)) {
      throw Errors.authorization('شما مجوز این عملیات را ندارید');
    }
    
    // Get target admin
    const targetAdmin = await prisma.admin.findUnique({ 
      where: { id: adminId } 
    });
    
    if (!targetAdmin) throw Errors.notFound('ادمین مورد نظر یافت نشد');
    
    // Check if requester is trying to edit an OWNER as a MANAGER
    if (requester.role === 'MANAGER' && targetAdmin.role === 'OWNER') {
      throw Errors.authorization('مدیر نمی‌تواند مالک را ویرایش کند');
    }
    
    // Validate request body
    const body = await request.json();
    const data = editAdminSchema.parse(body);
    
    // Additional permission checks
    if (data.role) {
      // Prevent MANAGER from promoting to OWNER
      if (requester.role === 'MANAGER' && data.role === 'OWNER') {
        throw Errors.authorization('مدیر نمی‌تواند نقش را به مالک تغییر دهد');
      }
      
      // Prevent self-demotion if it's the last OWNER
      if (data.role !== 'OWNER' && targetAdmin.role === 'OWNER') {
        const ownerCount = await prisma.admin.count({ 
          where: { role: 'OWNER' } 
        });
        
        if (ownerCount <= 1) {
          throw Errors.validation('حداقل باید یک مالک در سیستم وجود داشته باشد');
        }
      }
    }
    
    // Update admin
    const updatedAdmin = await prisma.admin.update({
      where: { id: adminId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        role: data.role,
        isActive: data.isActive,
      },
      select: {
        id: true,
        phoneNumber: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isActive: true,
        updatedAt: true,
      }
    });
    
    // Return success response with CORS headers
    const response = NextResponse.json(
      { 
        success: true, 
        message: SuccessMessages.ADMIN_UPDATED, 
        data: { admin: updatedAdmin } 
      },
      { status: 200 }
    );

    // Add CORS headers
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return response;
    
  } catch (error) {
    return handleError(error, request);
  }
}
