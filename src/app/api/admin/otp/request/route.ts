import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '../../../../../../lib/prisma';
import {generateOTP } from '../../../../../../lib/auth';
import { sendOTP } from '../../../../../../lib/kavenegar';

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
    // تجزیه و اعتبارسنجی بدنه درخواست
    const body = await request.json();
    const { phoneNumber } = requestOTPSchema.parse(body);

    // نرمال‌سازی شماره به فرمت +98
    const normalizedPhone = phoneNumber.startsWith('0') ? `+98${phoneNumber.slice(1)}` : phoneNumber;

    // یافتن ادمین با شماره تلفن
    const admin = await prisma.admin.findUnique({
      where: { phoneNumber: normalizedPhone },
    });

    if (!admin) {
      return NextResponse.json(
        { success: false, error: 'شماره تلفن در سیستم ثبت نشده است' },
        { status: 404 }
      );
    }

    // بررسی فعال بودن حساب
    if (!admin.isActive) {
      return NextResponse.json(
        { success: false, error: 'حساب کاربری شما غیرفعال است. با پشتیبانی تماس بگیرید' },
        { status: 403 }
      );
    }

    // بررسی قفل بودن حساب
    if (admin.lockedUntil && new Date() < new Date(admin.lockedUntil)) {
      return NextResponse.json(
        {
          success: false,
          error: `حساب شما تا ${new Date(admin.lockedUntil).toLocaleString('fa-IR')} قفل است`,
        },
        { status: 403 }
      );
    }

    // بررسی محدودیت تعداد درخواست (۵ درخواست در ۱۵ دقیقه)
    const ipAddress = request.headers.get('x-forwarded-for') || 'unknown';
    const recentAttempts = await prisma.adminSession.count({
      where: {
        adminId: admin.id,
        ipAddress,
        createdAt: {
          gte: new Date(Date.now() - 15 * 60 * 1000), // ۱۵ دقیقه آخر
        },
      },
    });

    if (recentAttempts >= 5) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) },
      });
      return NextResponse.json(
        {
          success: false,
          error: 'تعداد درخواست‌ها بیش از حد مجاز است. ۱۵ دقیقه دیگر تلاش کنید',
        },
        { status: 429 }
      );
    }

    // تولید و ارسال OTP
    const otp = generateOTP();
    const sent = await sendOTP(normalizedPhone, otp);

    if (!sent) {
      return NextResponse.json(
        { success: false, error: 'خطا در ارسال OTP. لطفاً دوباره تلاش کنید' },
        { status: 500 }
      );
    }

    // ذخیره OTP در سشن
    await prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: otp, // در تولید، OTP رو هش کن
        ipAddress,
        userAgent: request.headers.get('user-agent') || 'unknown',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // OTP ۵ دقیقه اعتبار دارد
        isValid: true,
      },
    });

    return NextResponse.json(
      { success: true, message: 'کد OTP با موفقیت ارسال شد' },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: error.errors.map((e) => e.message) },
        { status: 400 }
      );
    }
    console.error('خطای درخواست OTP:', error);
    return NextResponse.json(
      { success: false, error: 'خطای سرور. لطفاً با پشتیبانی تماس بگیرید' },
      { status: 500 }
    );
  }
}