import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { handleError } from '@lib/error-handler';
import { sign } from 'jsonwebtoken';

const verifySignupSchema = z.object({
  phoneNumber: z.string().min(1, 'شماره تلفن الزامی است')
    .regex(/^\+?[0-9\s-]+$/, 'شماره تلفن معتبر نیست'),
  otp: z.string().length(6, 'کد تایید باید ۶ رقمی باشد'),
  password: z.string()
    .min(6, 'رمز عبور باید حداقل ۶ کاراکتر باشد')
    .max(100, 'رمز عبور نمی‌تواند بیشتر از ۱۰۰ کاراکتر باشد'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { phoneNumber, otp, password } = verifySignupSchema.parse(body);
    
    // Format phone number to ensure consistency (remove any non-digit characters except +)
    const formattedPhoneNumber = phoneNumber.startsWith('+') 
      ? '+' + phoneNumber.replace(/\D/g, '') 
      : phoneNumber.replace(/\D/g, '');
    
    // Find the user with the temporary signup data
    const user = await prisma.user.findFirst({
      where: { 
        phoneNumber: formattedPhoneNumber,
        status: 'PHONE_VERIFICATION_PENDING',
        verificationToken: { not: null },
        verificationTokenExpires: { gte: new Date() }
      },
      select: {
        id: true,
        phoneNumber: true,
        verificationToken: true,
        verificationTokenExpires: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'کاربر یافت نشد یا قبلاً فعال‌سازی شده است',
          message: 'لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید'
        },
        { status: 404 }
      );
    }

    // Verify OTP (in production, use a secure comparison)
    if (user.verificationToken !== otp) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'کد تایید نامعتبر است',
          message: 'لطفاً کد تایید را به درستی وارد کنید'
        },
        { status: 400 }
      );
    }

    // Hash the password (you'll need to implement this function)
    const hashedPassword = await hashPassword(password);

    // Activate the user and store the hashed password
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashedPassword,
        verificationToken: null,
        verificationTokenExpires: null,
        phoneVerified: true,
        status: 'ACTIVE',
        lastLoginAt: new Date(),
      },
      select: {
        id: true,
        phoneNumber: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    // Generate JWT token
    const token = sign(
      { userId: updatedUser.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    // Set HTTP-only cookie
    const response = NextResponse.json(
      { 
        success: true, 
        message: 'ثبت‌نام با موفقیت انجام شد',
        data: {
          user: updatedUser,
        }
      },
      { status: 200 }
    );

    response.cookies.set({
      name: 'auth_token',
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: '/',
    });

    return response;

  } catch (error) {
    return handleError(error, request);
  }
}

// Helper function to hash password (you should use bcrypt or similar)
async function hashPassword(password: string): Promise<string> {
  // In a real app, use bcrypt or similar
  const bcrypt = await import('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
}
