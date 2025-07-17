import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { handleError } from '@lib/error-handler';
import { sign } from 'jsonwebtoken';
import { compare } from 'bcryptjs';

const loginSchema = z.object({
  phoneNumber: z
    .string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
  password: z.string()
    .min(6, 'رمز عبور باید حداقل ۶ کاراکتر باشد')
    .max(100, 'رمز عبور نمی‌تواند بیشتر از ۱۰۰ کاراکتر باشد')
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { phoneNumber, password } = loginSchema.parse(body);
    
    // Normalize phone number
    const normalizedPhone = phoneNumber.startsWith('+98') 
      ? phoneNumber 
      : phoneNumber.startsWith('0')
        ? `+98${phoneNumber.substring(1)}`
        : `+98${phoneNumber}`;
    
    // Find user by phone number
    const user = await prisma.user.findUnique({
      where: { 
        phoneNumber: normalizedPhone,
        status: 'ACTIVE'
      },
      select: {
        id: true,
        phoneNumber: true,
        email: true,
        firstName: true,
        lastName: true,
        passwordHash: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    });

    // Check if account is locked
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMinutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / (60 * 1000));
      return NextResponse.json(
        { 
          success: false, 
          error: 'حساب شما به دلیل تلاش‌های ناموفق قفل شده است',
          message: `لطفاً ${remainingMinutes} دقیقه دیگر تلاش کنید`
        },
        { status: 403 }
      );
    }

    // Check if user exists and password is correct
    if (!user || !user.passwordHash || !(await compare(password, user.passwordHash))) {
      // Increment failed login attempts
      if (user) {
        const failedAttempts = (user.failedLoginAttempts || 0) + 1;
        const updateData: { failedLoginAttempts: number; lockedUntil?: Date } = { 
        failedLoginAttempts: failedAttempts
      };
        
        // Lock account after 5 failed attempts for 30 minutes
        if (failedAttempts >= 5) {
          const lockUntil = new Date();
          lockUntil.setMinutes(lockUntil.getMinutes() + 30);
          updateData.lockedUntil = lockUntil;
        }
        
        await prisma.user.update({
          where: { id: user.id },
          data: updateData,
        });
        
        const remainingAttempts = 5 - failedAttempts;
        
        if (remainingAttempts <= 0) {
          return NextResponse.json(
            { 
              success: false, 
              error: 'حساب شما به مدت ۳۰ دقیقه قفل شد',
              message: 'لطفاً بعداً تلاش کنید یا از طریق فراموشی رمز عبور اقدام کنید'
            },
            { status: 403 }
          );
        }
        
        return NextResponse.json(
          { 
            success: false, 
            error: 'شماره موبایل یا رمز عبور اشتباه است',
            message: `شما ${remainingAttempts} تلاش دیگر دارید`
          },
          { status: 401 }
        );
      }
      
      return NextResponse.json(
        { 
          success: false, 
          error: 'شماره موبایل یا رمز عبور اشتباه است',
          message: 'لطفاً اطلاعات را بررسی کنید و دوباره تلاش کنید'
        },
        { status: 401 }
      );
    }

    // Reset failed login attempts on successful login
    await prisma.user.update({
      where: { id: user.id },
      data: { 
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // Generate JWT token
    const token = sign(
      { userId: user.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    // Set HTTP-only cookie
    const response = NextResponse.json(
      { 
        success: true, 
        message: 'ورود با موفقیت انجام شد',
        data: {
          user: {
            id: user.id,
            phoneNumber: user.phoneNumber,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
          },
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
