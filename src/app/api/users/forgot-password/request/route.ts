import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { generateOTP } from '@lib/otp-utils';
import { sendOTP } from '@lib/kavenegar';
import { handleError } from '@lib/error-handler';

const requestResetSchema = z.object({
  phoneNumber: z
    .string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { phoneNumber } = requestResetSchema.parse(body);
    
    // Normalize phone number
    const normalizedPhone = phoneNumber.startsWith('+98') 
      ? phoneNumber 
      : phoneNumber.startsWith('0')
        ? `+98${phoneNumber.substring(1)}`
        : `+98${phoneNumber}`;
    
    // Check if user exists and is active
    const user = await prisma.user.findFirst({
      where: { 
        phoneNumber: normalizedPhone,
        status: 'ACTIVE'
      },
      select: { 
        id: true, 
        phoneNumber: true,
        status: true
      },
    });

    if (!user) {
      // Don't reveal that the user doesn't exist
      return NextResponse.json(
        { 
          success: true, 
          message: 'اگر حساب کاربری با این شماره وجود داشته باشد، لینک بازنشانی رمز عبور ارسال خواهد شد'
        },
        { status: 200 }
      );
    }

    // Generate OTP
    const otp = generateOTP(6);
    const otpExpires = new Date();
    otpExpires.setMinutes(otpExpires.getMinutes() + 15); // 15 minutes expiry

    // In production, store OTP in a secure cache like Redis
    console.log(`Password reset OTP for ${normalizedPhone}: ${otp}`);

    // Send OTP via SMS
    const otpSent = await sendOTP(normalizedPhone, otp);
    
    if (!otpSent) {
      throw new Error('ارسال کد تایید با خطا مواجه شد');
    }

    // Store reset token in database (in production, use a separate service)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationToken: otp,
        verificationTokenExpires: otpExpires,
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
