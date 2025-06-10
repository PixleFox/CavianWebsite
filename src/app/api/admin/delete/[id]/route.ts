import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../../lib/prisma';
import { handleError, Errors } from '../../../../../../lib/error-handler';
import { SuccessMessages } from '../../../../../../lib/success-messages';
import { verifyToken } from '../../../../../../lib/auth';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
    
    // Prevent self-deletion
    if (decoded.adminId === adminId) {
      throw Errors.authorization('شما نمی‌توانید خودتان را حذف کنید');
    }
    
    // Get target admin
    const targetAdmin = await prisma.admin.findUnique({ 
      where: { id: adminId } 
    });
    
    if (!targetAdmin) throw Errors.notFound('ادمین مورد نظر یافت نشد');
    
    // Check if requester is trying to delete an OWNER as a MANAGER
    if (requester.role === 'MANAGER' && targetAdmin.role === 'OWNER') {
      throw Errors.authorization('مدیر نمی‌تواند مالک را حذف کند');
    }
    
    // Prevent deleting the last OWNER
    if (targetAdmin.role === 'OWNER') {
      const ownerCount = await prisma.admin.count({ 
        where: { role: 'OWNER' } 
      });
      
      if (ownerCount <= 1) {
        throw Errors.validation('حداقل باید یک مالک در سیستم وجود داشته باشد');
      }
    }
    
    // Delete admin and their sessions in a transaction
    await prisma.$transaction([
      prisma.adminSession.deleteMany({
        where: { adminId: adminId }
      }),
      prisma.admin.delete({
        where: { id: adminId }
      })
    ]);
    
    // Return success response
    return NextResponse.json(
      { 
        success: true, 
        message: SuccessMessages.ADMIN_DELETED,
        data: { adminId: adminId }
      },
      { status: 200 }
    );
    
  } catch (error) {
    return handleError(error, request);
  }
}
