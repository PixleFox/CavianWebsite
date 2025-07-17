import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { authenticateRequest } from '@lib/api-utils';
import { rateLimitMiddleware } from '@lib/rate-limiter';

// Input validation schema
const updateProfileSchema = z.object({
  firstName: z.string().min(2).max(50).optional(),
  lastName: z.string().min(2).max(50).optional(),
  email: z.string().email().optional(),
  phoneNumber: z.string().regex(/^[0-9]{10,15}$/).optional(),
  birthDate: z.string().datetime().optional(),
  nationalId: z.string().length(10).optional(),
  bankCardNumber: z.string().length(16).optional(),
  receiveNewsletter: z.boolean().optional(),
});

// GET /api/users/me - Get current user profile
export async function GET(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimit = await rateLimitMiddleware(
      request,
      'users:profile:get',
      'user',
      'detail'
    );
    
    if (rateLimit.isRateLimited) {
      return rateLimit.response;
    }

    // Authenticate user
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.userId) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get user profile
    const user = await prisma.user.findUnique({
      where: { id: authResult.userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        birthDate: true,
        nationalId: true,
        bankCardNumber: true,
        receiveNewsletter: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, message: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: user });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return NextResponse.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PATCH /api/users/me - Update current user profile
export async function PATCH(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimit = await rateLimitMiddleware(
      request,
      'users:profile:update',
      'user',
      'update'
    );
    
    if (rateLimit.isRateLimited) {
      return rateLimit.response;
    }

    // Authenticate user
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.userId) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const updateData = { ...body };

    // Check if phone number is being updated (only admins can change this)
    if ('phoneNumber' in updateData) {
      console.log(`User ${authResult.userId} attempted to change phone number - operation blocked`);
      return NextResponse.json(
        { 
          success: false, 
          message: 'شماره تلفن قابل تغییر نیست',
          error: 'تغییر شماره تلفن فقط توسط مدیر سیستم امکان پذیر است. لطفا با پشتیبانی تماس بگیرید.'
        },
        { status: 403 }
      );
    }

    // Validate request body
    const validation = updateProfileSchema.safeParse(updateData);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, message: 'Validation error', errors: validation.error.errors },
        { status: 400 }
      );
    }

    // Check if email already exists
    if (updateData.email) {
      const existingUser = await prisma.user.findFirst({
        where: {
          email: body.email,
          id: { not: authResult.userId }
        }
      });

      if (existingUser) {
        return NextResponse.json(
          { success: false, message: 'Email already in use' },
          { status: 400 }
        );
      }
    }

    // Update user profile
    const updatedUser = await prisma.user.update({
      where: { id: authResult.userId },
      data: {
        firstName: updateData.firstName,
        lastName: updateData.lastName,
        email: updateData.email,
        // phoneNumber is intentionally excluded - only admins can update it
        birthDate: updateData.birthDate ? new Date(updateData.birthDate) : undefined,
        nationalId: updateData.nationalId,
        bankCardNumber: updateData.bankCardNumber,
        receiveNewsletter: updateData.receiveNewsletter,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        birthDate: true,
        nationalId: true,
        bankCardNumber: true,
        receiveNewsletter: true,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Profile updated successfully',
      data: updatedUser
    });
  } catch (error) {
    console.error('Error updating user profile:', error);
    return NextResponse.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}
