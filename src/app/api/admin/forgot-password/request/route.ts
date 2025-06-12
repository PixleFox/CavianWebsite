import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import axios from 'axios';
import prisma from '../../../../../../lib/prisma';
import { handleError, Errors } from '../../../../../../lib/error-handler';
import { isRateLimited } from '../../../../../../lib/rate-limiter';
// Using process.env directly since we're in an API route

async function sendOTP(phoneNumber: string, otp: string): Promise<boolean> {
  const apiKey = process.env.KAVENEGAR_API_KEY as string;
  const template = process.env.KAVENEGAR_FORGOT_PASSWORD_TEMPLATE || 'forgot-password';

  if (!apiKey) {
    console.error('KAVENEGAR_API_KEY is not set in environment variables');
    return false;
  }

  // Normalize phone number: convert 0912... to +98912...
  const normalizedPhone = phoneNumber.startsWith('0') ? `+98${phoneNumber.slice(1)}` : 
                       phoneNumber.startsWith('98') ? `+${phoneNumber}` : 
                       phoneNumber.startsWith('+98') ? phoneNumber : 
                       `+98${phoneNumber}`;

  try {
    console.log('Sending OTP via Kavenegar to:', normalizedPhone);
    
    const response = await axios.post(
      `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json`,
      {},
      {
        params: {
          receptor: normalizedPhone,
          token: otp,
          template,
        },
        timeout: 10000 // 10 second timeout
      }
    );

    console.log('Kavenegar response:', response.data);
    return response.data.return.status === 200;
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error sending OTP via Kavenegar:', error.message);
      
      // Check if it's an Axios error
      interface KavenegarErrorResponse {
        response?: {
          status: number;
          data: {
            return?: {
              status: number;
              message: string;
            };
          };
        };
      }
      
      const axiosError = error as KavenegarErrorResponse;
      if (axiosError.response?.data) {
        console.error('Kavenegar API error response:', {
          status: axiosError.response.status,
          message: axiosError.response.data.return?.message || 'Unknown error'
        });
      }
    } else {
      console.error('Unknown error occurred while sending OTP');
    }
    return false;
  }
}

/**
 * Generates a random OTP (One-Time Password)
 * @param length - Length of the OTP (default: 6)
 * @returns A string containing only digits
 */
function generateOTP(length: number = 6): string {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}

/**
 * Calculates the expiration time for an OTP
 * @param minutes - Number of minutes until expiration (default: 15)
 * @returns A Date object representing the expiration time
 */
function getOTPExpiration(minutes: number = 15): Date {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

const requestSchema = z.object({
  phoneNumber: z.string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. مثال: 09123456789'
    })
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
    // Rate limiting check (2 minutes cooldown)
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
                    request.headers.get('x-real-ip') || 
                    'unknown';
    
    // Check IP-based rate limiting
    const rateLimit = isRateLimited(clientIp);
    if (rateLimit.isLimited) {
      return NextResponse.json(
        { 
          success: false, 
          error: `تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً ${rateLimit.retryAfter} ثانیه دیگر تلاش کنید.` 
        },
        { status: 429, headers: { 'Retry-After': rateLimit.retryAfter?.toString() || '120' } }
      );
    }

    const body = await request.json();
    const { phoneNumber } = requestSchema.parse(body);
    
    // Normalize the phone number for consistent matching
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    console.log('Normalized phone number:', normalizedPhone);
    
    // Check for recent OTP requests
    const recentRequest = await prisma.adminSession.findFirst({
      where: {
        admin: { 
          phoneNumber: normalizedPhone 
        },
        createdAt: { 
          gte: new Date(Date.now() - 2 * 60 * 1000) // Last 2 minutes
        },
        tokenHash: {
          not: undefined // Changed from null to undefined for Prisma
        }
      },
      orderBy: { 
        createdAt: 'desc' 
      },
      select: { 
        createdAt: true 
      }
    });

    if (recentRequest) {
      const timeLeft = Math.ceil((recentRequest.createdAt.getTime() + 2 * 60 * 1000 - Date.now()) / 1000);
      return NextResponse.json(
        { 
          success: false, 
          error: `لطفاً ${timeLeft} ثانیه دیگر برای درخواست کد جدید صبر کنید.` 
        },
        { status: 429, headers: { 'Retry-After': timeLeft.toString() } }
      );
    }
    
    // Find admin by exact phone number match
    const admin = await prisma.admin.findFirst({
      where: { phoneNumber: normalizedPhone },
      select: { 
        id: true, 
        isActive: true,
        phoneNumber: true
      }
    });
    
    // For security, don't reveal if the phone number exists or not
    if (!admin) {
      // Log failed attempt (without exposing user existence)
      console.log('Password reset requested for non-existent number');
      return NextResponse.json({
        success: true,
        message: 'اگر شماره وارد شده در سیستم وجود داشته باشد، کد بازیابی ارسال خواهد شد'
      });
    }

    if (!admin.isActive) {
      throw Errors.forbidden('حساب کاربری غیرفعال شده است');
    }

    // Generate a 6-digit OTP
    const otp = generateOTP(6);
    const expiresAt = getOTPExpiration(15); // 15 minutes from now
    const ipAddress = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    const userAgent = request.headers.get('user-agent') || 'unknown';

    // Create a new session with the OTP
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: await hash(otp, 10), // Store hashed OTP
        ipAddress,
        userAgent,
        expiresAt,
        isValid: true
      }
    });

    // Send OTP via Kavenegar
    const otpSent = await sendOTP(admin.phoneNumber, otp);
    
    if (!otpSent) {
      console.error('Failed to send OTP via Kavenegar');
      throw Errors.server(new Error('خطا در ارسال کد تایید. لطفاً دوباره تلاش کنید.'));
    }
    
    return NextResponse.json({
      success: true,
      message: 'کد تایید به شماره همراه شما ارسال شد'
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
