import { NextRequest, NextResponse } from 'next/server';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import prisma from '@lib/prisma';
import { hashPassword } from '@lib/auth';
import { authenticateRequest } from '@lib/api-utils';
import { rateLimitMiddleware } from '@lib/rate-limiter';

// Type guards for enums
function isUserRole(role: unknown): role is UserRole {
  return typeof role === 'string' && Object.values(UserRole).includes(role as UserRole);
}

function isUserStatus(status: unknown): status is UserStatus {
  return typeof status === 'string' && Object.values(UserStatus).includes(status as UserStatus);
}

import { 
  validatePhoneNumber, 
  validateBankCard, 
  validateNationalCode 
} from '@lib/validation';

// Type-safe update data interface
interface UserUpdateData {
  email?: string | null;
  phoneNumber?: string | null;
  nationalId?: string | null;
  bankCardNumber?: string | null;
  password?: string;
  role?: UserRole | null;
  status?: UserStatus | null;
  level?: number | null;
  [key: string]: unknown;
}

// Reusable error responses in Farsi
const errorMessages = {
  // Authentication/Authorization errors
  UNAUTHORIZED: {
    status: 401,
    error: 'احراز هویت ناموفق',
    message: 'لطفا وارد شوید'
  },
  FORBIDDEN: {
    status: 403,
    error: 'دسترسی غیرمجاز',
    message: 'شما مجوز دسترسی به این منبع را ندارید'
  },
  // Validation errors
  INVALID_REQUEST: {
    status: 400,
    error: 'درخواست نامعتبر',
    message: 'داده‌های ارسالی معتبر نمی‌باشد'
  },
  INVALID_PHONE: {
    status: 400,
    error: 'فرمت شماره تلفن نامعتبر است',
    message: 'لطفا یک شماره تلفن معتبر وارد کنید (مثال: 09123456789)'
  },
  INVALID_EMAIL: {
    status: 400,
    error: 'فرمت ایمیل نامعتبر است',
    message: 'لطفا یک آدرس ایمیل معتبر وارد کنید'
  },
  INVALID_NATIONAL_ID: {
    status: 400,
    error: 'کد ملی نامعتبر است',
    message: 'لطفا یک کد ملی معتبر ۱۰ رقمی وارد کنید'
  },
  INVALID_BANK_CARD: {
    status: 400,
    error: 'شماره کارت بانکی نامعتبر است',
    message: 'لطفا یک شماره کارت معتبر ۱۶ رقمی وارد کنید'
  },
  USER_NOT_FOUND: {
    status: 404,
    error: 'کاربر یافت نشد',
    message: 'کاربری با مشخصات وارد شده یافت نشد'
  },
  
  // Conflict errors
  EMAIL_EXISTS: {
    status: 409,
    error: 'ایمیل تکراری است',
    message: 'ایمیل وارد شده قبلاً ثبت شده است'
  },
  PHONE_EXISTS: {
    status: 409,
    error: 'شماره تلفن تکراری است',
    message: 'شماره تلفن وارد شده قبلاً ثبت شده است'
  },
  NATIONAL_ID_EXISTS: {
    status: 409,
    error: 'کد ملی تکراری است',
    message: 'کد ملی وارد شده قبلاً ثبت شده است'
  },
  
  // Server errors
  SERVER_ERROR: {
    status: 500,
    error: 'خطای سرور',
    message: 'خطایی در سرور رخ داده است. لطفاً دوباره تلاش کنید.'
  }
} as const;


// Success response helper
function successResponse<T>(data: T | null, status = 200, message = 'عملیات با موفقیت انجام شد') {
  return NextResponse.json({
    success: true,
    data,
    message,
    timestamp: new Date().toISOString()
  }, { status });
}

// Error response helper
type ErrorCode = keyof typeof errorMessages;

function errorResponse(code: ErrorCode, details?: string | object) {
  // Handle cases where the error code doesn't exist
  if (!(code in errorMessages)) {
    return NextResponse.json({
      success: false,
      status: 500,
      error: 'خطای سرور',
      message: 'خطایی در پردازش درخواست رخ داده است',
      ...(process.env.NODE_ENV === 'development' && { details }),
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
  // Handle INVALID_REQUEST if it's not in errorMessages
  if (code === 'INVALID_REQUEST' && !errorMessages.INVALID_REQUEST) {
    return NextResponse.json({
      success: false,
      status: 400,
      message: 'درخواست نامعتبر',
      description: 'داده‌های ارسالی معتبر نمی‌باشد',
      ...(process.env.NODE_ENV === 'development' && { details }),
      timestamp: new Date().toISOString()
    }, { status: 400 });
  }

  // Handle FORBIDDEN and UNAUTHORIZED specially
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    const status = code === 'FORBIDDEN' ? 403 : 401;
    return NextResponse.json({
      success: false,
      status,
      error: code === 'FORBIDDEN' ? 'دسترسی غیرمجاز' : 'احراز هویت ناموفق',
      message: code === 'FORBIDDEN' 
        ? 'شما مجوز دسترسی به این منبع را ندارید' 
        : 'لطفا وارد شوید',
      ...(process.env.NODE_ENV === 'development' && { details }),
      timestamp: new Date().toISOString()
    }, { status });
  }

  const { status, ...error } = errorMessages[code];
  return NextResponse.json({
    success: false,
    ...error,
    ...(process.env.NODE_ENV === 'development' && { details }),
    timestamp: new Date().toISOString()
  }, { status });
}

// Fields to include in API responses
const userSelect = {
  id: true,
  fullName: true,
  firstName: true,
  lastName: true,
  email: true,
  phoneNumber: true,
  nationalId: true,
  role: true,
  status: true,
  level: true,
  emailVerified: true,
  phoneVerified: true,
  createdAt: true,
  updatedAt: true,
} as const;

// UserUpdateData interface is already defined above

interface Params {
  params: {
    id: string;
  };
}

// Helper function to safely convert string ID to number
function parseUserId(id: string): number {
  const userId = parseInt(id, 10);
  if (isNaN(userId)) {
    throw new Error('شناسه کاربر نامعتبر است');
  }
  return userId;
}

export async function GET(request: NextRequest, { params }: Params) {
  // Apply rate limiting for user details
  const rateLimit = await rateLimitMiddleware(request, `/api/users/${params.id}`, 'user');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  try {
    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse('INVALID_REQUEST');
    }

    const userId = parseUserId(params.id);
    
    // Users can only access their own data, unless they're admins
    if (!auth.adminId) {
      // For non-admin users, check if they're accessing their own data
      const currentUser = await prisma.user.findUnique({
        where: { id: Number(auth.adminId) },
        select: { id: true }
      });
      
      if (!currentUser || currentUser.id !== userId) {
        return errorResponse('FORBIDDEN');
      }
    }

    const user = await prisma.user.findUnique({
      where: { 
        id: userId,
        deletedAt: null // Only return non-deleted users
      },
      select: auth.adminId ? userSelect : {
        // Regular users can only see limited fields
        id: true,
        fullName: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        role: true,
        status: true,
        level: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return errorResponse('USER_NOT_FOUND');
    }

    return successResponse(user);
  } catch (error) {
    console.error('خطا در دریافت اطلاعات کاربر:', error);
    return errorResponse('SERVER_ERROR', error instanceof Error ? error.message : undefined);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  // Apply rate limiting for user updates
  const rateLimit = await rateLimitMiddleware(request, `/api/users/${params.id}`, 'user');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  try {
    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse('INVALID_REQUEST');
    }

    const userId = parseUserId(params.id);
    
    // Users can only update their own data, unless they're admins
    if (!auth.adminId) {
      // For non-admin users, check if they're updating their own data
      const currentUser = await prisma.user.findUnique({
        where: { id: Number(auth.adminId) },
        select: { id: true }
      });
      
      if (!currentUser || currentUser.id !== userId) {
        return errorResponse('FORBIDDEN');
      }
    }
    
    // Parse and validate request body
    let data: UserUpdateData;
    try {
      data = (await request.json()) as UserUpdateData;
    } catch (err) {
      const error = err as Error;
      console.error('Error parsing request body:', error);
      return errorResponse('INVALID_REQUEST', 'Invalid JSON payload');
    }

    const { 
      password, 
      phoneNumber, 
      nationalId, 
      bankCardNumber, 
      email,
      ...updateData 
    } = data;

    // Check if user exists and not deleted
    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        id: true, 
        deletedAt: true,
        // Include role for role-based field validation
        role: true 
      }
    });
    
    // Prevent users from modifying sensitive fields unless admin
    if (!auth.adminId) {
      // Regular users can't modify these fields
      const restrictedFields = ['role', 'status', 'level', 'emailVerified', 'phoneVerified'];
      for (const field of restrictedFields) {
        if (field in data && data[field] !== undefined) {
          return errorResponse('FORBIDDEN', `Cannot modify restricted field: ${field}`);
        }
      }
      
      // For non-admin users, check if they're modifying their own data
      const currentUser = await prisma.user.findUnique({
        where: { id: Number(auth.adminId) },
        select: { id: true }
      });
      
      if (!currentUser || currentUser.id !== userId) {
        return errorResponse('FORBIDDEN');
      }
    }

    if (!existingUser || existingUser.deletedAt) {
      return errorResponse('USER_NOT_FOUND');
    }

    // Prepare update data with proper typing
    const updatePayload: Prisma.UserUpdateInput = {};
    
    // Helper function to safely update string fields
    const updateStringField = (
      field: keyof typeof updateData, 
      key: keyof Prisma.UserUpdateInput,
      validate?: (value: string) => boolean
    ) => {
      if (field in updateData && updateData[field] !== undefined) {
        const value = String(updateData[field]);
        if (!validate || validate(value)) {
          updatePayload[key] = value;
        } else {
          throw new Error(`Invalid value for ${String(field)}`);
        }
      }
      if (field in updateData && updateData[field] !== undefined) {
        const value = updateData[field];
        if (value === null) {
          // For nullable fields, set to null
          (updatePayload[key] as { set: string | null }) = { set: null };
        } else if (typeof value === 'string') {
          // For string values, set the value
          (updatePayload[key] as { set: string }) = { set: value };
        }
      }
    };

    // Update string fields
    updateStringField('email', 'email');
    updateStringField('firstName', 'firstName');
    updateStringField('lastName', 'lastName');
    updateStringField('fullName', 'fullName');
    updateStringField('nationalId', 'nationalId');
    updateStringField('bankCardNumber', 'bankCardNumber');

    // Handle role field with proper type safety
    if ('role' in updateData && updateData.role !== undefined) {
      const roleValue = updateData.role;
      if (roleValue === null) {
        (updatePayload.role as { set: UserRole | null }) = { set: null };
      } else if (typeof roleValue === 'string' && isUserRole(roleValue)) {
        (updatePayload.role as { set: UserRole }) = { set: roleValue };
      }
    }

    // Handle status field with proper type safety
    if ('status' in updateData && updateData.status !== undefined) {
      const statusValue = updateData.status;
      if (statusValue === null) {
        (updatePayload.status as { set: UserStatus | null }) = { set: null };
      } else if (typeof statusValue === 'string' && isUserStatus(statusValue)) {
        (updatePayload.status as { set: UserStatus }) = { set: statusValue };
      }
    }

    // Handle level field with proper type safety
    if ('level' in updateData && updateData.level !== undefined) {
      const levelValue = updateData.level;
      if (levelValue === null) {
        // Handle null case for level - using type assertion with Prisma's type
        // @ts-expect-error - We know this is safe because the field is nullable in the schema
        updatePayload.level = { set: null };
      } else if (typeof levelValue === 'number') {
        updatePayload.level = { set: levelValue };
      } else if (typeof levelValue === 'string' && !isNaN(Number(levelValue))) {
        updatePayload.level = { set: Number(levelValue) };
      }
    }

    // Handle password update with proper type safety
    if (password) {
      updatePayload.passwordHash = await hashPassword(password);
      // Remove password field to avoid type issues
      const { password: _unusedPassword, ...rest } = updateData as UserUpdateData;
      // Suppress unused variable warning
      void _unusedPassword; // Mark as intentionally unused
      Object.assign(updateData, rest);
    }

    // Validate and handle phone number
    if (phoneNumber !== undefined) {
      if (phoneNumber !== null && !validatePhoneNumber(phoneNumber)) {
        return errorResponse('INVALID_PHONE');
      }
      
      // Handle phone number update with proper type safety
      if (phoneNumber === null) {
        (updatePayload.phoneNumber as { set: string | null }) = { set: null };
      } else if (typeof phoneNumber === 'string') {
        (updatePayload.phoneNumber as { set: string }) = { set: phoneNumber };
      }
      
      // Remove from updateData to avoid duplicate updates
      delete (updateData as { phoneNumber?: string | null }).phoneNumber;
    }

    // Validate and handle national ID
    if (nationalId !== undefined) {
      if (nationalId && !validateNationalCode(nationalId)) {
        return errorResponse('INVALID_NATIONAL_ID');
      }
      // Handle national ID update
      if (nationalId) {
        updatePayload.nationalId = { set: nationalId };
      } else {
        updatePayload.nationalId = { set: null };
      }
      delete (updateData as { nationalId?: string | null }).nationalId;
    }

    // Validate and handle bank card
    if (bankCardNumber !== undefined) {
      if (bankCardNumber && !validateBankCard(bankCardNumber)) {
        return errorResponse('INVALID_BANK_CARD');
      }
      // Handle bank card update
      if (bankCardNumber) {
        updatePayload.bankCardNumber = { set: bankCardNumber };
      } else {
        updatePayload.bankCardNumber = { set: null };
      }
      delete (updateData as { bankCardNumber?: string | null }).bankCardNumber;
    }

    // Validate email if provided
    if (email !== undefined) {
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return errorResponse('INVALID_EMAIL');
      }
      // Handle email update
      if (email) {
        updatePayload.email = { set: email };
      } else {
        updatePayload.email = { set: null };
      }
      delete (updateData as { email?: string | null }).email;
    }

    // Check for duplicate identifiers
    try {
      const conditions = [];
      
      if (email) conditions.push({ email: String(email) });
      if (phoneNumber) conditions.push({ phoneNumber: String(phoneNumber) });
      if (nationalId) conditions.push({ nationalId: String(nationalId) });
      
      if (conditions.length > 0) {
        const existingIdentifiers = await prisma.user.findFirst({
          where: {
            id: { not: userId }, // Exclude current user
            deletedAt: null,
            OR: conditions as Prisma.UserWhereInput[]
          },
          select: { 
            email: true, 
            phoneNumber: true, 
            nationalId: true 
          }
        });

        if (existingIdentifiers) {
          if (email && existingIdentifiers.email === email) {
            return errorResponse('EMAIL_EXISTS');
          }
          if (phoneNumber && existingIdentifiers.phoneNumber === phoneNumber) {
            return errorResponse('PHONE_EXISTS');
          }
          if (nationalId && existingIdentifiers.nationalId === nationalId) {
            return errorResponse('NATIONAL_ID_EXISTS');
          }
        }
      }
    } catch (err) {
      const error = err as Error;
      console.error('خطا در بررسی تکراری‌ها:', error);
      return errorResponse('SERVER_ERROR', error.message);
    }

    // Update user with all validated data
    try {
      // Merge any remaining updateData fields
      if (Object.keys(updateData).length > 0) {
        Object.assign(updatePayload, updateData);
      }
      
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: updatePayload,
        select: userSelect,
      });

      return successResponse(updatedUser, 200, 'اطلاعات کاربر با موفقیت به‌روزرسانی شد');
    } catch (err) {
      const error = err as Prisma.PrismaClientKnownRequestError;
      console.error('خطا در به‌روزرسانی کاربر:', error);
      
      // Handle Prisma unique constraint errors
      if (error.code === 'P2002') {
        const target = error.meta?.target as string[] | undefined;
        if (target?.includes('email')) return errorResponse('EMAIL_EXISTS');
        if (target?.includes('phoneNumber')) return errorResponse('PHONE_EXISTS');
        if (target?.includes('nationalId')) return errorResponse('NATIONAL_ID_EXISTS');
        return errorResponse('SERVER_ERROR', `Duplicate entry for field: ${target?.[0] || 'unknown'}`);
      }
      if (error.code === 'P2025') {
        return errorResponse('USER_NOT_FOUND');
      }
      
      throw error; // Will be caught by the outer catch
    }
  } catch (error) {
    console.error('خطای سرور در به‌روزرسانی کاربر:', error);
    return errorResponse('SERVER_ERROR', error instanceof Error ? error.message : undefined);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  // Apply rate limiting for user deletion
  const rateLimit = await rateLimitMiddleware(request, `/api/users/${params.id}`, 'admin');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  try {
    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse('INVALID_REQUEST');
    }

    const userId = parseUserId(params.id);
    
    // Only admins can delete users, and they can't delete themselves
    if (!auth.adminId) {
      return errorResponse('FORBIDDEN');
    }
    
    // Prevent admins from deleting themselves
    if (auth.adminId === userId) {
      return errorResponse('FORBIDDEN', 'Cannot delete your own account');
    }
    
    // First verify the user exists and not already deleted
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true }
    });

    if (!user) {
      return errorResponse('USER_NOT_FOUND');
    }

    // Check if already soft-deleted
    if (user.deletedAt) {
      return successResponse(
        null, 
        200, 
        'این کاربر قبلاً حذف شده است'
      );
    }

    // Perform soft delete by setting deletedAt
    await prisma.user.update({
      where: { id: userId },
      data: { 
        deletedAt: new Date(),
        status: 'INACTIVE',
      },
    });

    return successResponse(
      null, 
      200, 
      'کاربر با موفقیت غیرفعال و به سطل زباله منتقل شد'
    );
  } catch (error) {
    console.error('خطا در حذف کاربر:', error);
    
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return errorResponse('USER_NOT_FOUND');
      }
    }
    
    return errorResponse('SERVER_ERROR', error instanceof Error ? error.message : undefined);
  }
}
