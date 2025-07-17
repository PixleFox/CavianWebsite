import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { handleError } from '@lib/error-handler';
import { hash, compare } from 'bcryptjs';

// Password strength validation
const passwordSchema = z.string()
  .min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد')
  .max(100, 'رمز عبور نمی‌تواند بیشتر از ۱۰۰ کاراکتر باشد')
  .regex(/[A-Z]/, 'رمز عبور باید حداقل شامل یک حرف بزرگ باشد')
  .regex(/[a-z]/, 'رمز عبور باید حداقل شامل یک حرف کوچک باشد')
  .regex(/[0-9]/, 'رمز عبور باید حداقل شامل یک عدد باشد')
  .regex(/[^A-Za-z0-9]/, 'رمز عبور باید حداقل شامل یک کاراکتر خاص باشد');

// Base schema for input validation
const baseResetPasswordSchema = z.object({
  phoneNumber: z.string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
  otp: z.string().length(6, 'کد تایید باید ۶ رقمی باشد'),
  newPassword: passwordSchema,
});

// Extended schema with async validation
const resetPasswordSchema = baseResetPasswordSchema.superRefine(async (data, ctx) => {
  // Normalize phone number
  const normalizedPhone = data.phoneNumber.startsWith('+98') 
    ? data.phoneNumber 
    : data.phoneNumber.startsWith('0')
      ? `+98${data.phoneNumber.substring(1)}`
      : `+98${data.phoneNumber}`;

  try {
    // Check if user exists and get current password hash
    const user = await prisma.user.findFirst({
      where: { 
        phoneNumber: normalizedPhone,
        status: 'ACTIVE',
        verificationToken: data.otp,
      },
      select: {
        id: true,
        passwordHash: true,
        verificationTokenExpires: true,
      },
    });

    if (!user) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'کد تایید نامعتبر است',
        path: ['otp']
      });
      return;
    }

    // Check if OTP is expired
    if (!user.verificationTokenExpires || new Date() > user.verificationTokenExpires) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'کد تایید منقضی شده است',
        path: ['otp']
      });
      return;
    }

    // Check if new password is different from current
    if (user.passwordHash) {
      const isSamePassword = await compare(data.newPassword, user.passwordHash);
      if (isSamePassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'رمز عبور جدید نباید با رمز عبور قبلی یکسان باشد',
          path: ['newPassword']
        });
      }
    }
  } catch (err) {
    console.error('Error in forgot-password verify:', err);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'خطا در بررسی اطلاعات',
      path: ['server']
    });
  }
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // Parse and validate the request body
    const result = await resetPasswordSchema.safeParseAsync(body);
    
    if (!result.success) {
      const errorMap: Record<string, string> = {};
      
      result.error.issues.forEach(issue => {
        const path = issue.path.join('.');
        errorMap[path] = issue.message;
      });
      
      return NextResponse.json(
        { 
          success: false, 
          error: 'خطای اعتبارسنجی',
          message: 'لطفاً اطلاعات را بررسی کنید',
          errors: errorMap
        },
        { status: 400 }
      );
    }
    
    const { phoneNumber, otp, newPassword } = result.data;
    
    // Normalize phone number
    const normalizedPhone = phoneNumber.startsWith('+98') 
      ? phoneNumber 
      : phoneNumber.startsWith('0')
        ? `+98${phoneNumber.substring(1)}`
        : `+98${phoneNumber}`;
    
    // Find the user to update
    const user = await prisma.user.findFirst({
      where: { 
        phoneNumber: normalizedPhone,
        status: 'ACTIVE',
        verificationToken: otp,
      },
      select: {
        id: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'خطای سرور',
          message: 'خطایی رخ داده است. لطفاً دوباره تلاش کنید'
        },
        { status: 500 }
      );
    }

    // Hash the new password
    const hashedPassword = await hash(newPassword, 10);

    // Update password and clear verification token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashedPassword,
        verificationToken: null,
        verificationTokenExpires: null,
        failedLoginAttempts: 0, // Reset failed login attempts
        lockedUntil: null, // Unlock account if it was locked
      },
    });

    return NextResponse.json(
      { 
        success: true, 
        message: 'رمز عبور با موفقیت تغییر یافت',
      },
      { status: 200 }
    );

  } catch (error) {
    return handleError(error, request);
  }
}
