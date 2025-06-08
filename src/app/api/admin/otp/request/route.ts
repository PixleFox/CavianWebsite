import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../lib/prisma';
import { sendOTP, generateOTP } from '../../../../../lib/kavenegar';

// Input validation schema
const requestOTPSchema = z.object({
  phoneNumber: z.string().regex(/^\+\d{10,15}$/, 'Invalid phone number format'),
});

export async function POST(request: NextRequest) {
  try {
    // Parse and validate request body
    const body = await request.json();
    const { phoneNumber } = requestOTPSchema.parse(body);

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

    // Check if admin is active
    if (!admin.isActive) {
      return NextResponse.json(
        { success: false, error: 'Account is deactivated' },
        { status: 403 }
      );
    }

    // Check if account is locked
    if (admin.lockedUntil && new Date() < new Date(admin.lockedUntil)) {
      return NextResponse.json(
        { success: false, error: 'Account is locked' },
        { status: 403 }
      );
    }

    // Check rate limit (5 attempts per 15 minutes, IP-based)
    const ipAddress = request.headers.get('x-forwarded-for') || 'unknown';
    const recentAttempts = await prisma.adminSession.count({
      where: {
        adminId: admin.id,
        ipAddress,
        createdAt: {
          gte: new Date(Date.now() - 15 * 60 * 1000), // Last 15 minutes
        },
      },
    });

    if (recentAttempts >= 5) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });
      return NextResponse.json(
        { success: false, error: 'Too many attempts, try again later' },
        { status: 429 }
      );
    }

    // Generate and send OTP
    const otp = generateOTP();
    const sent = await sendOTP(phoneNumber, otp);

    if (!sent) {
      return NextResponse.json(
        { success: false, error: 'Failed to send OTP' },
        { status: 500 }
      );
    }

    // Store OTP in session (in production, hash the OTP)
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: otp, // Temporary storage; hash in production
        ipAddress,
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // OTP expires in 5 minutes
        isValid: true,
      },
    });

    return NextResponse.json(
      { success: true, message: 'OTP sent successfully' },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: error.errors },
        { status: 400 }
      );
    }
    console.error('Request OTP error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}