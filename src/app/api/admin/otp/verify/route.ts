import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../lib/prisma';
import { generateToken } from '../../../../../lib/auth';

// Input validation schema
const verifyOTPSchema = z.object({
  phoneNumber: z.string().regex(/^\+\d{10,15}$/, 'Invalid phone number format'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
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
        { success: false, error: 'Phone number not registered' },
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
        { success: false, error: 'Invalid or expired OTP' },
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
        tokenHash: token, // In production, hash the token
        ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        isValid: true,
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          token,
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
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: error.errors },
        { status: 400 }
      );
    }
    console.error('Verify OTP error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}