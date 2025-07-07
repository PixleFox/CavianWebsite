import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import { generateOTP } from '../../../../../../lib/auth';
import { sendOTP } from '../../../../../../lib/kavenegar';
import { handleError, Errors } from '../../../../../../lib/error-handler';
import { isRateLimited } from '../../../../../../lib/rate-limiter';
import { SuccessMessages } from '../../../../../../lib/success-messages';
import { normalizePhoneNumber } from '../../../../../../lib/phone-utils';

// Define Admin type for raw query result
interface Admin {
  id: number;
  phoneNumber: string;
  isActive: boolean;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  // Add other properties that might be needed
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  createdAt?: Date;
  updatedAt?: Date;
  creatorId?: number | null;
}

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

    // Normalize the input phone number to standard format (+989...)
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    // Remove any non-digit characters for comparison
    const cleanPhoneNumber = normalizedPhone.replace(/\D/g, '');
    
    // Find admin by phone number using raw query that handles all formats
    const adminResults = await prisma.$queryRaw<Admin[]>`
      WITH normalized_phones AS (
        SELECT 
          id,
          "phoneNumber",
          "isActive",
          "lockedUntil",
          "failedLoginAttempts",
          email,
          "firstName",
          "lastName",
          role,
          "createdAt",
          "updatedAt",
          "creatorId",
          -- Clean phone number: remove all non-digit characters
          REGEXP_REPLACE("phoneNumber", '[^0-9]', '', 'g') as clean_phone
        FROM "Admin"
      )
      SELECT 
        id::integer as id, 
        "phoneNumber", 
        "isActive", 
        "lockedUntil", 
        "failedLoginAttempts"::integer as "failedLoginAttempts",
        email,
        "firstName",
        "lastName",
        role,
        "createdAt",
        "updatedAt",
        "creatorId"::integer as "creatorId"
      FROM normalized_phones
      WHERE 
        -- Match any of these formats:
        -- 1. Exact match with + (e.g., +989123456789)
        "phoneNumber" = ${normalizedPhone} OR
        -- 2. Match without + (e.g., 989123456789)
        "phoneNumber" = ${normalizedPhone.replace('+', '')} OR
        -- 3. Match with 0 instead of +98 (e.g., 09123456789)
        (${normalizedPhone.startsWith('+98')} AND "phoneNumber" = '0' || SUBSTRING(${normalizedPhone}, 4)) OR
        -- 4. Match any other format by cleaning all non-digits
        clean_phone = ${cleanPhoneNumber} OR
        -- 5. Match if the stored number is in +98 format but input is 0...
        (clean_phone = '98' || SUBSTRING(${cleanPhoneNumber}, 2) AND ${cleanPhoneNumber.startsWith('0')})
      LIMIT 1
    `;
    
    const adminData = adminResults.length > 0 ? adminResults[0] : null;

    if (!adminData) {
      // Return a generic error message that doesn't reveal whether the phone number exists
      throw Errors.notFound('شماره تلفن وارد شده معتبر نمی‌باشد یا حساب کاربری با این شماره یافت نشد.');
    }

    // Check if account is locked
    if (adminData.lockedUntil && new Date() < adminData.lockedUntil) {
      const remainingTime = Math.ceil((adminData.lockedUntil.getTime() - Date.now()) / 60000); // in minutes
      throw Errors.tooManyRequests(
        `حساب شما به دلیل تلاش‌های ناموفق به مدت ${remainingTime} دقیقه قفل شده است.`
      );
    }

    // بررسی فعال بودن حساب
    if (!adminData.isActive) {
      throw Errors.authorization('حساب کاربری شما غیرفعال است. با پشتیبانی تماس بگیرید');
    }

    // بررسی قفل بودن حساب
    if (adminData.lockedUntil && new Date() < new Date(adminData.lockedUntil)) {
      throw Errors.authorization(
        `حساب شما تا ${new Date(adminData.lockedUntil as Date).toLocaleString('fa-IR')} قفل است`
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
          adminId: adminData.id,
          createdAt: {
            gte: new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
          },
        },
      }),
      prisma.adminSession.count({
        where: {
          adminId: adminData.id,
          isValid: false,
          createdAt: {
            gte: new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
          },
        },
      }),
      prisma.adminSession.findFirst({
        where: {
          adminId: adminData.id,
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
        where: { id: adminData.id },
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

    // Generate OTP
    const otp = generateOTP();
    
    // Get the actual phone number from the database to ensure consistency
    const actualPhoneNumber = adminData.phoneNumber;
    
    // Normalize the phone number for sending (ensure it starts with +98)
    const phoneToSend = actualPhoneNumber.startsWith('0') 
      ? `+98${actualPhoneNumber.substring(1)}` 
      : actualPhoneNumber.startsWith('98')
        ? `+${actualPhoneNumber}`
        : actualPhoneNumber.startsWith('+')
          ? actualPhoneNumber
          : `+98${actualPhoneNumber}`;
    
    // Send OTP to the phone number
    console.log(`Sending OTP to: ${phoneToSend}`);
    const sent = await sendOTP(phoneToSend, otp);

    if (!sent) {
      console.error(`Failed to send OTP to: ${phoneToSend}`);
      throw new Error('خطا در ارسال OTP. لطفاً دوباره تلاش کنید');
    }

    // Hash the OTP before storing in the database
    const crypto = await import('crypto');
    const hashedOTP = crypto
      .createHash('sha256')
      .update(otp)
      .digest('hex');

    // Store the hashed OTP in the session
    await prisma.adminSession.create({
      data: {
        adminId: adminData.id,
        tokenHash: hashedOTP,
        ipAddress: ipAddress,
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // OTP valid for 5 minutes
        isValid: true,
      },
    });

    return NextResponse.json(
      { 
        success: true, 
        message: SuccessMessages.OTP_SENT,
        data: { 
          phoneNumber: adminData.phoneNumber,
          cooldown: 120 // 2 minutes in seconds
        }
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error, request);
  }
}