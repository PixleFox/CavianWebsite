import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sign } from 'jsonwebtoken';
import prisma from '../../../../../../../lib/prisma';
import { handleError } from '../../../../../../../lib/error-handler';

const verifyOTPLoginSchema = z.object({
  phoneNumber: z.string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
  otp: z.string().length(6, 'کد تایید باید ۶ رقمی باشد'),
});

export async function POST(request: NextRequest) {
  try {
    // Log request headers
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    console.log('Request headers:', JSON.stringify(headers, null, 2));
    
    // Get raw body text for debugging
    const rawBody = await request.text();
    console.log('Raw request body:', rawBody);
    
    // Parse JSON body
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
      console.log('Parsed request body:', JSON.stringify(body, null, 2));
    } catch (parseError) {
      console.error('Error parsing JSON body:', parseError);
      return NextResponse.json(
        { success: false, error: 'Invalid JSON format in request body' },
        { status: 400 }
      );
    }
    
    // Validate request body
    if (!body || typeof body !== 'object') {
      console.error('Invalid request body format');
      return NextResponse.json(
        { success: false, error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }
    
    // Validate schema
    const result = verifyOTPLoginSchema.safeParse(body);
    if (!result.success) {
      console.error('Validation error:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Validation error',
          details: result.error.format()
        },
        { status: 400 }
      );
    }
    
    const { phoneNumber, otp } = result.data;
    
    // Normalize phone number
    const normalizedPhone = phoneNumber.startsWith('+98') 
      ? phoneNumber 
      : phoneNumber.startsWith('0')
        ? `+98${phoneNumber.substring(1)}`
        : `+98${phoneNumber}`;
    
    // Find the user with verification token
    const user = await prisma.user.findFirst({
      where: { 
        phoneNumber: normalizedPhone,
        verificationToken: otp,
        verificationTokenExpires: { 
          gte: new Date() 
        }
      },
      select: {
        id: true,
        phoneNumber: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        phoneVerified: true,
        email: true,
        firstName: true,
        lastName: true
      }
    });

    if (!user) {
      return NextResponse.json(
        { success: false, message: 'کد تایید نامعتبر یا منقضی شده است' },
        { status: 400 }
      );
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return NextResponse.json(
        { 
          success: false, 
          message: `حساب شما به دلیل تلاش‌های ناموفق متعدد تا ${user.lockedUntil.toLocaleTimeString('fa-IR')} قفل شده است`,
          lockedUntil: user.lockedUntil
        },
        { status: 403 }
      );
    }

    // Update user status and clear verification data
    await prisma.user.update({
      where: { id: user.id },
      data: { 
        verificationToken: null,
        verificationTokenExpires: null,
        failedLoginAttempts: 0,
        lastLoginAt: new Date(),
        phoneVerified: true,
        status: 'ACTIVE' // Update status to active after successful verification
      }
    });

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }

    // Create JWT token
    const token = sign(
      { 
        userId: user.id,
        phoneNumber: user.phoneNumber,
        type: 'user'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set HTTP-only cookie
    const response = NextResponse.json(
      { 
        success: true, 
        message: 'ورود با موفقیت انجام شد',
        data: {
          userId: user.id,
          phoneNumber: user.phoneNumber
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
