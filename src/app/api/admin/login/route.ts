import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../lib/prisma';
import { handleError, Errors } from '../../../../../lib/error-handler';
import { SuccessMessages } from '../../../../../lib/success-messages';
import { compare } from 'bcryptjs';
import { sign } from 'jsonwebtoken';

const loginSchema = z.object({
  phoneNumber: z.string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
  password: z.string()
    .min(6, 'رمز عبور باید حداقل ۶ کاراکتر باشد')
    .max(100, 'رمز عبور نمی‌تواند بیشتر از ۱۰۰ کاراکتر باشد')
});

/**
 * Normalizes phone number to international format with +98 prefix
 * Examples:
 * 09128442592 -> +989128442592
 * 989128442592 -> +989128442592
 * 9128442592 -> +989128442592
 * +989128442592 -> +989128442592
 */
const normalizePhoneNumber = (phone: string): string => {
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
  
  throw new Error('شماره موبایل معتبر نیست');
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = loginSchema.parse(body);
    
    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(data.phoneNumber);
    
    // Find admin by phone number
    const admin = await prisma.admin.findUnique({
      where: { phoneNumber: normalizedPhone },
      select: {
        id: true,
        phoneNumber: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isActive: true,
        passwordHash: true
      }
    });

    // Check if admin exists and is active
    if (!admin) {
      throw Errors.unauthorized('شماره موبایل یا رمز عبور نادرست است');
    }
    
    if (!admin.isActive) {
      throw Errors.forbidden('حساب کاربری غیرفعال شده است');
    }
    
    // Verify password
    const isPasswordValid = await compare(data.password, admin.passwordHash);
    if (!isPasswordValid) {
      throw Errors.unauthorized('شماره موبایل یا رمز عبور نادرست است');
    }
    
    // Check for existing active session
    const existingSession = await prisma.adminSession.findFirst({
      where: { 
        adminId: admin.id,
        expiresAt: { gt: new Date() } // Only check for non-expired sessions
      }
    });

    if (existingSession) {
      throw Errors.forbidden('شما در حال حاضر در دستگاه دیگری وارد شده‌اید. لطفاً ابتدا از آن دستگاه خارج شوید.');
    }

    // Generate JWT token
    const token = sign(
      { 
        adminId: admin.id,
        role: admin.role,
        phoneNumber: admin.phoneNumber 
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );
    
    // Calculate token expiration (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    // Create session in database
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: token, // In production, you might want to hash the token
        expiresAt,
        userAgent: request.headers.get('user-agent') || 'unknown',
        ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
        isValid: true
      }
    });

    // Create response with only the admin data we need
    const adminData = {
      id: admin.id,
      phoneNumber: admin.phoneNumber,
      firstName: admin.firstName,
      lastName: admin.lastName,
      email: admin.email,
      role: admin.role,
      isActive: admin.isActive
    };
    
    // Create response with token in HTTP-only cookie
    const response = NextResponse.json(
      { 
        success: true, 
        message: SuccessMessages.LOGIN_SUCCESS,
        data: { 
          admin: adminData,
          token // For client-side usage if needed
        } 
      },
      { 
        status: 200,
        headers: {
          'Set-Cookie': `adminToken=${token}; Path=/; HttpOnly; SameSite=Strict; ${
            process.env.NODE_ENV === 'production' ? 'Secure; ' : ''
          }Max-Age=604800` // 7 days
        }
      }
    );
    
    return response;
    
  } catch (error) {
    return handleError(error, request);
  }
}

// Add OPTIONS handler for CORS preflight
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
