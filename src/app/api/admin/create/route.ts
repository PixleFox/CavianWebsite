import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import prisma from '../../../../../lib/prisma';
import { handleError, Errors } from '../../../../../lib/error-handler';
import { SuccessMessages } from '../../../../../lib/success-messages';
import { verifyToken } from '../../../../../lib/auth'; 

// Generate a random password for new admins
const generateRandomPassword = () => {
  return Math.random().toString(36).slice(-8);
};

const normalizePhoneNumber = (phone: string): string => {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  
  // Check if it's a valid Iranian mobile number (9XXXXXXXXX or 09XXXXXXXXX or +989XXXXXXXXX)
  if (/^(\+98|0)?9\d{9}$/.test(phone)) {
    // Convert to format: 989XXXXXXXXX
    return digits.startsWith('98') ? digits : 
           digits.startsWith('0') ? `98${digits.substring(1)}` : 
           `98${digits}`;
  }
  throw new Error('شماره موبایل معتبر نیست. فرمت صحیح: 09123456789 یا 989123456789 یا +989123456789');
};

const createAdminSchema = z.object({
  phoneNumber: z.string()
    .min(10, 'شماره تلفن باید حداقل ۱۰ رقم باشد')
    .max(13, 'شماره تلفن حداکثر باید ۱۳ رقم باشد')
    .refine(phone => /^(\+98|0)?9\d{9}$/.test(phone), {
      message: 'فرمت شماره موبایل معتبر نیست. لطفاً شماره را به فرمت صحیح وارد کنید (مثال: 09123456789)'
    }),
  firstName: z.string()
    .min(2, 'نام حداقل باید ۲ کاراکتر باشد')
    .max(50, 'نام نمی‌تواند بیشتر از ۵۰ کاراکتر باشد'),
  lastName: z.string()
    .min(2, 'نام خانوادگی حداقل باید ۲ کاراکتر باشد')
    .max(50, 'نام خانوادگی نمی‌تواند بیشتر از ۵۰ کاراکتر باشد'),
  role: z.enum(['OWNER', 'MANAGER', 'SELLER', 'MARKETER', 'OPERATOR'], {
    errorMap: () => ({ message: 'نقش انتخاب شده معتبر نیست' })
  }).default('OPERATOR'),
  isActive: z.boolean().default(true),
  email: z.string()
    .email('ایمیل معتبر نیست')
    .max(100, 'ایمیل نمی‌تواند بیشتر از ۱۰۰ کاراکتر باشد')
    .optional()
    .nullable()
    .transform(val => val || null),
});

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const token = request.cookies.get('adminToken')?.value;
    if (!token) throw Errors.authorization('دسترسی غیرمجاز');
    
    const decoded = verifyToken(token);
    if (!decoded) throw Errors.authorization('توکن نامعتبر است');
    
    // Get requester info
    const requester = await prisma.admin.findUnique({ 
      where: { id: decoded.adminId } 
    });
    
    if (!requester) throw Errors.authorization('ادمین معتبر یافت نشد');
    
    // Check permissions
    if (['SELLER', 'MARKETER', 'OPERATOR'].includes(requester.role)) {
      throw Errors.authorization('شما مجوز این عملیات را ندارید');
    }
    
    // Validate request body
    const body = await request.json();
    const data = createAdminSchema.parse(body);
    
    // Additional permission check for MANAGER
    if (requester.role === 'MANAGER' && data.role === 'OWNER') {
      throw Errors.authorization('مدیر نمی‌تواند مالک ایجاد کند');
    }
    
    // Normalize and validate phone number
    const normalizedPhone = normalizePhoneNumber(data.phoneNumber);
    
    // Check for existing admin with same phone or email
    const [phoneExists, emailExists] = await Promise.all([
      prisma.admin.findUnique({ where: { phoneNumber: normalizedPhone } }),
      data.email ? prisma.admin.findUnique({ where: { email: data.email } }) : null
    ]);
    
    if (phoneExists) {
      throw Errors.validation('این شماره موبایل قبلاً ثبت شده است');
    }
    
    if (emailExists && data.email) {
      throw Errors.validation('این آدرس ایمیل قبلاً ثبت شده است');
    }
    
    // Generate a random password
    const password = generateRandomPassword();
    const passwordHash = await hash(password, 10);
    
    try {
      // Create new admin with transaction
      const newAdmin = await prisma.$transaction(async (tx) => {
        // Check again for duplicates within the transaction
        const [existingPhone, existingEmail] = await Promise.all([
          tx.admin.findUnique({ where: { phoneNumber: normalizedPhone } }),
          data.email ? tx.admin.findUnique({ where: { email: data.email } }) : null
        ]);

        if (existingPhone) {
          throw Errors.validation('این شماره موبایل قبلاً ثبت شده است');
        }
        
        if (existingEmail && data.email) {
          throw Errors.validation('این آدرس ایمیل قبلاً ثبت شده است');
        }

        return await tx.admin.create({
          data: {
            phoneNumber: normalizedPhone,
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
            email: data.email?.trim() || null,
            passwordHash,
            role: data.role,
            isActive: data.isActive,
            creatorId: decoded.adminId,
          },
          select: {
            id: true,
            phoneNumber: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            isActive: true,
            createdAt: true,
          }
        });
      });
      
      // In a real app, you would send the password to the admin via email or SMS
      console.log(`New admin created with password: ${password}`);
      
      // Return success response
      return NextResponse.json(
        { 
          success: true, 
          message: SuccessMessages.ADMIN_CREATED, 
          data: { admin: newAdmin } 
        }, 
        { status: 201 }
      );
      
    } catch (error) {
      return handleError(error, request);
    }
  } catch (error) {
    return handleError(error, request);
  }
}
