import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import { generateOTP } from '../../../../../../lib/auth';
import { sendOTP } from '../../../../../../lib/kavenegar';
import { handleError, Errors } from '../../../../../../lib/error-handler';
import { isRateLimited } from '../../../../../../lib/rate-limiter';
import { SuccessMessages } from '../../../../../../lib/success-messages';

// اعتبارسنجی ورودی
const requestOTPSchema = z.object({
  phoneNumber: z
    .string()
    .regex(
      /^(?:\+989\d{9}|09\d{9})$/,
      'شماره تلفن باید در فرمت +989123456789 (13 کاراکتر) یا 09123456789 (11 کاراکتر) باشد'
    ),
});

export async function POST(request: NextRequest) {
  try {
    // Rate limiting check
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
                    request.headers.get('x-real-ip') || 
                    'unknown';
    
    const rateLimit = isRateLimited(clientIp);
    if (rateLimit.isLimited) {
      return NextResponse.json(
        { 
          success: false, 
          error: `تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً ${rateLimit.retryAfter} ثانیه دیگر تلاش کنید.` 
        },
        { status: 429, headers: { 'Retry-After': rateLimit.retryAfter?.toString() || '60' } }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const { phoneNumber } = requestOTPSchema.parse(body);

    // نرمال‌سازی شماره به فرمت +98
    const normalizedPhone = phoneNumber.startsWith('0') ? `+98${phoneNumber.slice(1)}` : phoneNumber;

    // یافتن ادمین با شماره تلفن
    const admin = await prisma.admin.findUnique({
      where: { phoneNumber: normalizedPhone },
    });

    if (!admin) {
      // Don't reveal that the phone number doesn't exist to prevent enumeration
      // Return success to not leak information
      return NextResponse.json(
        { 
          success: true, 
          message: SuccessMessages.OTP_SENT,
          data: { 
            phoneNumber: normalizedPhone,
            cooldown: 120 // 2 minutes in seconds
          }
        },
        { status: 200 }
      );
    }

    // Check if account is locked
    if (admin.lockedUntil && new Date() < admin.lockedUntil) {
      const remainingTime = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 60000); // in minutes
      throw Errors.tooManyRequests(
        `حساب شما به دلیل تلاش‌های ناموفق به مدت ${remainingTime} دقیقه قفل شده است.`
      );
    }

    // بررسی فعال بودن حساب
    if (!admin.isActive) {
      throw Errors.authorization('حساب کاربری شما غیرفعال است. با پشتیبانی تماس بگیرید');
    }

    // بررسی قفل بودن حساب
    if (admin.lockedUntil && new Date() < new Date(admin.lockedUntil)) {
      throw Errors.authorization(
        `حساب شما تا ${new Date(admin.lockedUntil).toLocaleString('fa-IR')} قفل است`
      );
    }

    // Simple IP tracking - gets the first IP from x-forwarded-for or falls back to x-real-ip
    const getClientIp = (req: NextRequest): string => {
      // Get IP from x-forwarded-for header (common in production)
      const forwardedFor = req.headers.get('x-forwarded-for');
      if (forwardedFor) {
        // Take the first IP in the list (client IP is usually first)
        return forwardedFor.split(',')[0].trim();
      }
      
      // Fall back to x-real-ip if available
      return req.headers.get('x-real-ip') || 'unknown';
    };
    
    const ipAddress = getClientIp(request) || 'unknown';

    // Check recent OTP requests and failed attempts
    const [recentAttempts, failedAttempts, lastOTPRequest] = await Promise.all([
      prisma.adminSession.count({
        where: {
          adminId: admin.id,
          createdAt: {
            gte: new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
          },
        },
      }),
      prisma.adminSession.count({
        where: {
          adminId: admin.id,
          isValid: false,
          createdAt: {
            gte: new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
          },
        },
      }),
      prisma.adminSession.findFirst({
        where: {
          adminId: admin.id,
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          createdAt: true,
        },
      }),
    ]);

    // If too many failed attempts, lock the account
    if (failedAttempts >= 4) { // 4 failed attempts + current one = 5
      const lockoutTime = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes lockout
      await prisma.admin.update({
        where: { id: admin.id },
        data: { 
          lockedUntil: lockoutTime,
          failedLoginAttempts: 0, // Reset counter when locking
        },
      });
      
      throw Errors.tooManyRequests(
        'حساب شما به دلیل تلاش‌های ناموفق به مدت ۱۵ دقیقه قفل شد.'
      );
    }

    // Check OTP cooldown (2 minutes between requests)
    const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
    if (lastOTPRequest?.createdAt) {
      const timeSinceLastRequest = Date.now() - lastOTPRequest.createdAt.getTime();
      const remainingCooldown = Math.ceil((COOLDOWN_MS - timeSinceLastRequest) / 1000); // in seconds
      
      if (timeSinceLastRequest < COOLDOWN_MS) {
        throw Errors.tooManyRequests(
          `لطفاً ${remainingCooldown} ثانیه دیگر برای درخواست کد جدید صبر کنید.`
        );
      }
    }

    // If too many total attempts, rate limit
    if (recentAttempts >= 5) {
      throw Errors.tooManyRequests(
        'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر تلاش کنید.'
      );
    }

    // تولید و ارسال OTP
    const otp = generateOTP();
    const sent = await sendOTP(normalizedPhone, otp);

    if (!sent) {
      throw new Error('خطا در ارسال OTP. لطفاً دوباره تلاش کنید');
    }

    // هش کردن OTP قبل از ذخیره در دیتابیس
    const crypto = await import('crypto');
    const hashedOTP = crypto
      .createHash('sha256')
      .update(otp)
      .digest('hex');

    // ذخیره هش OTP در سشن
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: hashedOTP,
        ipAddress: ipAddress,
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // OTP ۵ دقیقه اعتبار دارد
        isValid: true,
      },
    });

    return NextResponse.json(
      { 
        success: true, 
        message: SuccessMessages.OTP_SENT,
        data: { 
          phoneNumber: admin.phoneNumber,
          cooldown: 120 // 2 minutes in seconds
        }
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error, request);
  }
}