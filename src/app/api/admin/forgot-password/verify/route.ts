import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash, compare } from 'bcryptjs';
import prisma from '../../../../../../lib/prisma';
import { handleError, Errors } from '../../../../../../lib/error-handler';

const verifySchema = z.object({
  phoneNumber: z.string().min(10, 'شماره تلفن معتبر نیست'),
  otp: z.string().min(6, 'کد تایید باید ۶ رقمی باشد').max(6, 'کد تایید باید ۶ رقمی باشد'),
  newPassword: z.string()
    .min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])(?=.{8,})/,
      'رمز عبور باید شامل حروف بزرگ و کوچک، عدد و کاراکتر ویژه باشد'
    )
});

/**
 * Normalizes phone number to international format with +98 prefix
 * Examples:
 * 09128442592 -> +989128442592
 * 989128442592 -> +989128442592
 * 9128442592 -> +989128442592
 * +989128442592 -> +989128442592
 */
function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters
  const clean = phone.replace(/\D/g, '');
  
  // Handle different formats
  if (clean.startsWith('98')) {
    return `+${clean}`;
  } else if (clean.startsWith('0')) {
    return `+98${clean.substring(1)}`;
  } else if (clean.startsWith('+98')) {
    return phone; // Already in correct format
  } else if (clean.length === 10 && clean.startsWith('9')) {
    return `+98${clean}`;
  }
  
  // If no pattern matches, return as is but ensure it has +98
  return clean.startsWith('+') ? clean : `+98${clean}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { phoneNumber, otp, newPassword } = verifySchema.parse(body);
    
    // Normalize the phone number
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    // Find the admin by phone number
    const admin = await prisma.admin.findFirst({
      where: { phoneNumber: normalizedPhone },
      select: { 
        id: true,
        isActive: true 
      }
    });

    if (!admin) {
      throw Errors.notFound('حساب کاربری یافت نشد');
    }

    if (!admin.isActive) {
      throw Errors.forbidden('حساب کاربری غیرفعال شده است');
    }

    // Find a valid, unexpired session with this OTP
    const now = new Date();
    const session = await prisma.adminSession.findFirst({
      where: {
        adminId: admin.id,
        isValid: true,
        expiresAt: { gt: now },
        tokenHash: { not: undefined }
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tokenHash: true
      }
    });

    if (!session || !session.tokenHash) {
      throw Errors.unauthorized('کد تایید نامعتبر یا منقضی شده است');
    }

    // Verify the OTP
    const isOtpValid = await compare(otp, session.tokenHash);
    if (!isOtpValid) {
      throw Errors.unauthorized('کد تایید نامعتبر است');
    }

    // Hash the new password
    const passwordHash = await hash(newPassword, 10);

    // Update password and invalidate all sessions in a transaction
    await prisma.$transaction([
      // Update the password
      prisma.admin.update({
        where: { id: admin.id },
        data: { 
          passwordHash,
          updatedAt: new Date()
        }
      }),
      
      // Invalidate all active sessions including the current one
      prisma.adminSession.updateMany({
        where: { 
          adminId: admin.id,
          isValid: true
        },
        data: { 
          isValid: false,
          expiresAt: new Date()
        }
      }),
      
      // Mark the used OTP as invalid
      prisma.adminSession.update({
        where: { id: session.id },
        data: { 
          isValid: false,
          expiresAt: new Date()
        }
      })
    ]);

    return NextResponse.json({
      success: true,
      message: 'رمز عبور با موفقیت تغییر یافت. لطفاً با رمز عبور جدید وارد شوید.'
    });

  } catch (error) {
    return handleError(error, request);
  }
}

// Handle OPTIONS for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
