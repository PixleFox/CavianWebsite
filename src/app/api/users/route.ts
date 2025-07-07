import { NextRequest, NextResponse } from 'next/server';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import prisma from '@lib/prisma';
import { hashPassword } from '@lib/auth';
import { authenticateRequest } from '@lib/api-utils';
import { rateLimitMiddleware } from '@lib/rate-limiter';
import { 
  validatePhoneNumber, 
  validateBankCard, 
  validateNationalCode 
} from '@lib/validation';

// Reusable error responses in Farsi
const errorMessages = {
  // Validation errors
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
  INVALID_JSON: {
    status: 400,
    error: 'فرمت درخواست نامعتبر است',
    message: 'لطفا اطلاعات را به صورت صحیح ارسال کنید'
  },
  INVALID_REQUEST: {
    status: 400,
    error: 'درخواست نامعتبر',
    message: 'درخواست ارسال شده معتبر نمی‌باشد'
  },
  INVALID_REQUEST_BODY: {
    status: 400,
    error: 'بدنه درخواست نامعتبر است',
    message: 'لطفا اطلاعات را به صورت صحیح ارسال کنید'
  },
  EMAIL_OR_PHONE_REQUIRED: {
    status: 400,
    error: 'ایمیل یا شماره تلفن الزامی است',
    message: 'حداقل یکی از فیلدهای ایمیل یا شماره تلفن الزامی است'
  },
  PASSWORD_REQUIRED: {
    status: 400,
    error: 'رمز عبور الزامی است',
    message: 'لطفا رمز عبور را وارد کنید'
  },
  MISSING_CREDENTIALS: {
    status: 400,
    error: 'مشخصات اجباری ارسال نشده است',
    message: 'حداقل یکی از فیلدهای ایمیل یا شماره تلفن الزامی است و رمز عبور اجباری است'
  },
  WEAK_PASSWORD: {
    status: 400,
    error: 'رمز عبور ضعیف است',
    message: 'رمز عبور باید حداقل ۸ کاراکتر و شامل حروف بزرگ، کوچک و اعداد باشد'
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

type ErrorCode = keyof typeof errorMessages | 'INVALID_JSON' | 'INVALID_REQUEST' | 'INVALID_REQUEST_BODY' | 'EMAIL_OR_PHONE_REQUIRED' | 'PASSWORD_REQUIRED';

// Success response helper with generic type
function successResponse<T>(data: T, status = 200) {
  return NextResponse.json({
    success: true,
    data,
    message: 'عملیات با موفقیت انجام شد',
    timestamp: new Date().toISOString()
  }, { status });
}

// Error response helper with proper type for details
function errorResponse(code: ErrorCode, details?: string | Record<string, unknown> | Error) {
  // Handle unknown error codes
  const errorInfo = errorMessages[code as keyof typeof errorMessages];
  
  if (!errorInfo) {
    console.error('Unknown error code:', code);
    return NextResponse.json(
      { 
        success: false,
        error: 'خطای سرور', 
        message: 'خطای ناشناخته رخ داده است',
        ...(process.env.NODE_ENV === 'development' && { details, errorCode: code }),
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
  
  const { status, ...error } = errorInfo;
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
};

// Password strength validation
function isStrongPassword(password: string): boolean {
  // At least 8 characters, 1 uppercase, 1 lowercase, 1 number
  const strongRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d\W_]{8,}$/;
  return strongRegex.test(password);
}

// Type guards for enums
function isUserRole(role: string): role is UserRole {
  return Object.values(UserRole).includes(role as UserRole);
}

function isUserStatus(status: string): status is UserStatus {
  return Object.values(UserStatus).includes(status as UserStatus);
}

export async function GET(request: NextRequest) {
  // Apply rate limiting for user listing (admin only)
  const rateLimit = await rateLimitMiddleware(request, '/api/users', 'admin');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  try {
    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || errorResponse('INVALID_REQUEST');
    }

    // Only admin can list all users
    if (!auth.adminId) {
      return errorResponse('INVALID_REQUEST');
    }

    const users = await prisma.user.findMany({
      select: userSelect,
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    
    return successResponse(users);
  } catch (error) {
    console.error('خطا در دریافت لیست کاربران:', error);
    return errorResponse('SERVER_ERROR', error instanceof Error ? error.message : undefined);
  }
}

export async function POST(request: NextRequest) {
  // Public endpoint - no authentication required for user registration
  // Apply stricter rate limiting for user registration to prevent abuse
  const rateLimit = await rateLimitMiddleware(request, '/api/users', 'sensitive');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  try {
    // Parse and validate request body with proper typing
    interface UserCreateRequest {
      email?: string | null;
      phoneNumber?: string | null;
      password: string;
      fullName?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      nationalId?: string | null;
      bankCardNumber?: string | null;
      role?: string;
      status?: string;
      level?: number | string;
    }

    let data: UserCreateRequest;
    try {
      const body = await request.json();
      
      // Validate required fields
      if (!body || typeof body !== 'object') {
        return errorResponse('INVALID_REQUEST_BODY');
      }

      // Validate required fields based on the request
      if (!body.email && !body.phoneNumber) {
        return errorResponse('EMAIL_OR_PHONE_REQUIRED');
      }
      if (!body.password) {
        return errorResponse('PASSWORD_REQUIRED');
      }
      
      data = {
        email: body.email ? String(body.email) : undefined,
        phoneNumber: body.phoneNumber ? String(body.phoneNumber) : undefined,
        password: String(body.password || ''),
        fullName: body.fullName ? String(body.fullName) : undefined,
        firstName: body.firstName ? String(body.firstName) : undefined,
        lastName: body.lastName ? String(body.lastName) : undefined,
        nationalId: body.nationalId ? String(body.nationalId) : undefined,
        bankCardNumber: body.bankCardNumber ? String(body.bankCardNumber) : undefined,
        role: body.role ? String(body.role) : undefined,
        status: body.status ? String(body.status) : undefined,
        level: body.level !== undefined ? Number(body.level) : undefined,
      };
    } catch (err) {
      console.error('Error parsing request body:', err);
      if (err instanceof SyntaxError) {
        return errorResponse('INVALID_JSON');
      }
      return errorResponse('INVALID_REQUEST');
    }

    const {
      email,
      phoneNumber,
      password,
      fullName,
      firstName,
      lastName,
      nationalId,
      bankCardNumber,
      role = 'CUSTOMER',
      status = 'EMAIL_VERIFICATION_PENDING',
      level = 1,
    } = data as {
      email?: string;
      phoneNumber?: string;
      password: string;
      fullName?: string;
      firstName?: string;
      lastName?: string;
      nationalId?: string;
      bankCardNumber?: string;
      role: string;
      status: string;
      level: number;
    };

    // Basic validation
    if ((!email && !phoneNumber) || !password) {
      return errorResponse('MISSING_CREDENTIALS');
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return errorResponse('INVALID_EMAIL');
    }

    // Validate phone number format if provided
    if (phoneNumber && !validatePhoneNumber(phoneNumber)) {
      return errorResponse('INVALID_PHONE');
    }

    // Validate password strength
    if (!isStrongPassword(password)) {
      return errorResponse('WEAK_PASSWORD');
    }

    // Validate national ID if provided
    if (nationalId !== undefined) {
      if (nationalId && !validateNationalCode(nationalId)) {
        return errorResponse('INVALID_NATIONAL_ID');
      }
    }

    // Validate bank card number if provided
    if (bankCardNumber && !validateBankCard(bankCardNumber)) {
      return errorResponse('INVALID_BANK_CARD');
    }

    // Check for existing user with same identifiers
    try {
      const conditions: Prisma.UserWhereInput[] = [];
      if (email) conditions.push({ email: String(email) });
      if (phoneNumber) conditions.push({ phoneNumber: String(phoneNumber) });
      if (nationalId) conditions.push({ nationalId: { equals: nationalId } });
      
      if (conditions.length > 0) {
        const existingUser = await prisma.user.findFirst({
          where: { 
            OR: conditions,
            deletedAt: null // Only check non-deleted users
          },
          select: { email: true, phoneNumber: true, nationalId: true }
        });

        if (existingUser) {
          if (email && existingUser.email === email) return errorResponse('EMAIL_EXISTS');
          if (phoneNumber && existingUser.phoneNumber === phoneNumber) return errorResponse('PHONE_EXISTS');
          if (nationalId && existingUser.nationalId === nationalId) return errorResponse('NATIONAL_ID_EXISTS');
        }
      }
    } catch (error) {
      console.error('خطا در بررسی تکراری‌ها:', error);
      return errorResponse('SERVER_ERROR', error instanceof Error ? error.message : 'Unknown error');
    }

    // Hash password
    const hashedPassword = await hashPassword(password);
    
    // Generate verification token
    const verificationToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    
    const verificationTokenExpires = new Date();
    verificationTokenExpires.setHours(verificationTokenExpires.getHours() + 24);

    // Create user with proper typing
    try {
      // Build user data with proper type safety
      const userData: Prisma.UserCreateInput = {
        email: email ?? null,
        // @ts-expect-error - The field is nullable in the Prisma schema
        phoneNumber: phoneNumber ?? null,
        passwordHash: hashedPassword,
        fullName: fullName ?? 
                 (firstName || lastName ? 
                   `${firstName || ''} ${lastName || ''}`.trim() : null),
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        nationalId: nationalId ?? null,
        bankCardNumber: bankCardNumber || null,
        role: (role && isUserRole(role)) ? role : 'CUSTOMER',
        status: (status && isUserStatus(status)) ? status : 'EMAIL_VERIFICATION_PENDING',
        level: level || 1,
        verificationToken,
        verificationTokenExpires,
      };

      const user = await prisma.user.create({
        data: userData,
        select: userSelect,
      });

      // In production, you would send a verification email/SMS here
      // await sendVerificationEmail(user.email, verificationToken);

      return successResponse(user, 201);
    } catch (error) {
      console.error('خطا در ایجاد کاربر:', error);
      
      // Handle Prisma unique constraint errors
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          const target = error.meta?.target as string[];
          if (target.includes('email')) return errorResponse('EMAIL_EXISTS');
          if (target.includes('phoneNumber')) return errorResponse('PHONE_EXISTS');
          if (target.includes('nationalId')) return errorResponse('NATIONAL_ID_EXISTS');
        }
      }
      
      throw error; // Will be caught by the outer catch
    }
  } catch (error) {
    console.error('خطای سرور در ایجاد کاربر:', error);
    return errorResponse('SERVER_ERROR', error instanceof Error ? error.message : undefined);
  }
}
