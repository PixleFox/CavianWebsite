import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import { generateToken } from '../../../../../../lib/auth';

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
      return NextResponse.json(
        { success: false, error: 'شماره تلفن ثبت نشده است' },
        { status: 404 }
      );
    }

    // Find valid OTP session
    const session = await prisma.adminSession.findFirst({
      where: {
        adminId: admin.id,
        tokenHash: otp,
        isValid: true,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { failedLoginAttempts: admin.failedLoginAttempts + 1 },
      });
      return NextResponse.json(
        { success: false, error: 'OTP نامعتبر یا منقضی شده است' },
        { status: 401 }
      );
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

    // Create new session for JWT
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: token, // در تولید، توکن رو هش کن
        ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // ۱ ساعت
        isValid: true,
      },
    });

    // Set JWT in HttpOnly cookie
    const response = NextResponse.json(
      {
        success: true,
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
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: error.errors },
        { status: 400 }
      );
    }
    console.error('خطای تأیید OTP:', error);
    return NextResponse.json(
      { success: false, error: 'خطای سرور' },
      { status: 500 }
    );
  }
}