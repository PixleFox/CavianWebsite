import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../../lib/prisma';
import { generateOTP } from '../../../../../../../lib/otp-utils';
import { sendOTP } from '../../../../../../../lib/kavenegar';
import { handleError } from '../../../../../../../lib/error-handler';
import { normalizePhoneNumber } from '../../../../../../../lib/phone-utils';

const requestOTPSchema = z.object({
  phoneNumber: z
    .string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    }),
});

export async function POST(request: NextRequest) {
  console.log('=== OTP Request Debug ===');
  console.log('Request URL:', request.url);
  console.log('Request Headers:', Object.fromEntries(request.headers.entries()));
  
  try {
    console.log('Parsing request body...');
    const body = await request.json();
    console.log('Request Body:', body);
    
    console.log('Validating phone number...');
    const { phoneNumber } = requestOTPSchema.parse(body);
    console.log('Validated phone number:', phoneNumber);
    
    // Normalize phone number
    console.log('Normalizing phone number...');
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    console.log('Normalized phone number:', normalizedPhone);
    
    console.log('Checking if user exists...');
    // Check if user exists (allow both ACTIVE and PHONE_VERIFICATION_PENDING statuses)
    const user = await prisma.user.findFirst({
      where: { 
        phoneNumber: normalizedPhone,
        status: {
          in: ['ACTIVE', 'PHONE_VERIFICATION_PENDING']
        }
      },
      select: { 
        id: true, 
        phoneNumber: true,
        status: true
      },
    });

    if (!user) {
      console.log('User not found with phone number:', normalizedPhone);
      return NextResponse.json(
        { 
          success: false, 
          error: 'کاربری با این شماره موبایل یافت نشد',
          message: 'لطفاً ابتدا ثبت‌نام کنید',
          debug: {
            normalizedPhone,
            timestamp: new Date().toISOString()
          }
        },
        { status: 404 }
      );
    }

    // Generate OTP
    console.log('Generating OTP...');
    const otp = generateOTP(6);
    const otpExpires = new Date();
    otpExpires.setMinutes(otpExpires.getMinutes() + 15); // 15 minutes expiry

    // Log OTP generation (in production, this should be stored in a secure cache like Redis)
    console.log('OTP Details:', {
      phoneNumber: normalizedPhone,
      otp,
      expiresAt: otpExpires.toISOString(),
      userId: user.id
    });

    // Send OTP via SMS
    const otpSent = await sendOTP(normalizedPhone, otp);
    
    if (!otpSent) {
      throw new Error('ارسال کد تایید با خطا مواجه شد');
    }

    // Update user with verification token
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
