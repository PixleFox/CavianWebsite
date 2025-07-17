import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '@lib/prisma';
import { authenticateRequest } from '@lib/api-utils';
import { rateLimitMiddleware } from '@lib/rate-limiter';

// Input validation schema
const updateAdminProfileSchema = z.object({
  firstName: z.string().min(2).max(50).optional(),
  lastName: z.string().min(2).max(50).optional(),
  email: z.string().email().optional(),
  phoneNumber: z.string().regex(/^[0-9]{10,15}$/).optional(),
  currentPassword: z.string().min(6).optional(),
  newPassword: z.string().min(6).optional(),
});

// GET /api/admin/me - Get current admin profile
export async function GET(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimit = await rateLimitMiddleware(
      request,
      'admin:profile:get',
      'admin',
      'detail'
    );
    
    if (rateLimit.isRateLimited) {
      return rateLimit.response;
    }

    // Authenticate admin
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.adminId) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get admin profile
    const admin = await prisma.admin.findUnique({
      where: { id: authResult.adminId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!admin) {
      return NextResponse.json(
        { success: false, message: 'Admin not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: admin });
  } catch (error) {
    console.error('Error fetching admin profile:', error);
    return NextResponse.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/me - Update current admin profile
export async function PATCH(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimit = await rateLimitMiddleware(
      request,
      'admin:profile:update',
      'admin',
      'update'
    );
    
    if (rateLimit.isRateLimited) {
      return rateLimit.response;
    }

    // Authenticate admin
    const authResult = await authenticateRequest(request);
    if (!authResult.success || !authResult.adminId) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const validation = updateAdminProfileSchema.safeParse(body);
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'Validation error',
          errors: validation.error.errors 
        },
        { status: 400 }
      );
    }

    // Check if email is being updated and if it's already in use
    if (body.email) {
      const existingAdmin = await prisma.admin.findFirst({
        where: {
          email: body.email,
          id: { not: authResult.adminId }
        }
      });

      if (existingAdmin) {
        return NextResponse.json(
          { success: false, message: 'Email already in use' },
          { status: 400 }
        );
      }
    }

    // Check if phone number is being updated and if it's already in use
    if (body.phoneNumber) {
      const existingAdmin = await prisma.admin.findFirst({
        where: {
          phoneNumber: body.phoneNumber,
          id: { not: authResult.adminId }
        }
      });

      if (existingAdmin) {
        return NextResponse.json(
          { success: false, message: 'Phone number already in use' },
          { status: 400 }
        );
      }
    }

    // Handle password change if requested
    const updateData: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phoneNumber?: string;
      passwordHash?: string;
    } = {
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phoneNumber: body.phoneNumber,
    };

    if (body.newPassword) {
      if (!body.currentPassword) {
        return NextResponse.json(
          { success: false, message: 'Current password is required to change password' },
          { status: 400 }
        );
      }

      // Verify current password
      const admin = await prisma.admin.findUnique({
        where: { id: authResult.adminId },
        select: { passwordHash: true }
      });

      if (!admin) {
        return NextResponse.json(
          { success: false, message: 'Admin not found' },
          { status: 404 }
        );
      }

      const isPasswordValid = await bcrypt.compare(body.currentPassword, admin.passwordHash);
      if (!isPasswordValid) {
        return NextResponse.json(
          { success: false, message: 'Current password is incorrect' },
          { status: 400 }
        );
      }

      // Hash new password
      const salt = await bcrypt.genSalt(10);
      updateData.passwordHash = await bcrypt.hash(body.newPassword, salt);
    }

    // Update admin profile
    const updatedAdmin = await prisma.admin.update({
      where: { id: authResult.adminId },
      data: updateData,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        role: true,
        isActive: true,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Profile updated successfully',
      data: updatedAdmin
    });
  } catch (error) {
    console.error('Error updating admin profile:', error);
    return NextResponse.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}
