import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import { generateToken } from '../../../../../../lib/auth';
import { handleError, Errors } from '../../../../../../lib/error-handler';
import { SuccessMessages } from '../../../../../../lib/success-messages';

// Input validation schema
const verifyOTPSchema = z.object({
  phoneNumber: z.string().regex(/^\+\d{10,15}$/, 'شماره تلفن نامعتبر است'),
  otp: z.string().length(6, 'OTP باید ۶ رقم باشد'),
});

export async function POST(request: NextRequest) {
  try {
    // Parse and validate request body
    const body = await request.json();
    const { phoneNumber, otp } = verifyOTPSchema.parse(body);

    // Find admin by phone number
    const admin = await prisma.admin.findUnique({
      where: { phoneNumber },
    });

    if (!admin) {
      throw Errors.notFound('شماره تلفن ثبت نشده است');
    }

    // Hash the input OTP for comparison
    const crypto = await import('crypto');
    const hashedOTP = crypto
      .createHash('sha256')
      .update(otp)
      .digest('hex');

    // Find valid OTP session with the hashed OTP
    const session = await prisma.adminSession.findFirst({
      where: {
        adminId: admin.id,
        tokenHash: hashedOTP,
        isValid: true,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { failedLoginAttempts: admin.failedLoginAttempts + 1 },
      });
      throw Errors.authentication('OTP نامعتبر یا منقضی شده است');
    }

    // Reset failed login attempts and update login time
    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // Invalidate OTP session
    await prisma.adminSession.update({
      where: { id: session.id },
      data: { isValid: false },
    });

    // Generate JWT
    const token = generateToken(admin.id, admin.role);

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
    
    const ip = getClientIp(request) || 'unknown';

    // Create new session for JWT
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: token,
        ipAddress: ip,
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // ۱ ساعت
        isValid: true,
      },
    });

    // Set JWT in HttpOnly cookie
    const response = NextResponse.json(
      {
        success: true,
        message: SuccessMessages.OTP_VERIFIED,
        data: {
          admin: {
            id: admin.id,
            phoneNumber: admin.phoneNumber,
            firstName: admin.firstName,
            lastName: admin.lastName,
            role: admin.role,
          },
        },
      },
      { status: 200 }
    );

    response.cookies.set('adminToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // فقط تو تولید Secure
      sameSite: 'strict',
      maxAge: 60 * 60, // ۱ ساعت
      path: '/',
    });

    return response;
  } catch (error) {
    return handleError(error, request);
  }
}