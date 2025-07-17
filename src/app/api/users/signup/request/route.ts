import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import { generateOTP } from '../../../../../../lib/otp-utils';
import { sendOTP } from '../../../../../../lib/kavenegar';
import { handleError } from '../../../../../../lib/error-handler';
import { normalizePhoneNumber } from '../../../../../../lib/phone-utils';

const signupSchema = z.object({
  phoneNumber: z
    .string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
  email: z.string().email('ایمیل معتبر نیست').optional(),
  firstName: z.string().min(2, 'نام باید حداقل ۲ کاراکتر باشد').optional(),
  lastName: z.string().min(2, 'نام خانوادگی باید حداقل ۲ کاراکتر باشد').optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = signupSchema.parse(body);
    
    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(data.phoneNumber);
    
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { phoneNumber: normalizedPhone },
      select: { id: true }
    });

    if (existingUser) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'کاربری با این شماره موبایل قبلاً ثبت‌نام کرده است',
          message: 'لطفاً وارد شوید یا از گزینه فراموشی رمز عبور استفاده کنید'
        },
        { status: 400 }
      );
    }

    // Generate OTP
    const otp = generateOTP(6);
    const otpExpires = new Date();
    otpExpires.setMinutes(otpExpires.getMinutes() + 15); // 15 minutes expiry

    // Here you would typically store the OTP in a cache like Redis
    // For now, we'll just log it for testing
    console.log(`OTP for ${normalizedPhone}: ${otp}`);

    // Send OTP via SMS
    const otpSent = await sendOTP(normalizedPhone, otp);
    
    if (!otpSent) {
      throw new Error('ارسال کد تایید با خطا مواجه شد');
    }

    // Create user with temporary data (not active yet)
    const user = await prisma.user.create({
      data: {
        phoneNumber: normalizedPhone,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        passwordHash: '', // Will be set during verification
        verificationToken: otp,
        verificationTokenExpires: otpExpires,
        status: 'PHONE_VERIFICATION_PENDING',
        emailVerified: false,
        phoneVerified: false,
      },
      select: {
        id: true,
        phoneNumber: true,
      },
    });

    return NextResponse.json(
      { 
        success: true, 
        message: 'کد تایید به شماره شما ارسال شد',
        data: {
          userId: user.id,
          phoneNumber: user.phoneNumber,
        }
      },
      { status: 200 }
    );

  } catch (error) {
    return handleError(error, request);
  }
}
