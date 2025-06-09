import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/prisma';
import { verifyToken } from '../../../../../lib/auth';

export async function GET(request: NextRequest) {
  try {
    // دریافت توکن از کوکی
    const token = request.cookies.get('adminToken')?.value;
    console.log('توکن از کوکی:', token); // دیباگ

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'هیچ توکنی برای خروج یافت نشد' },
        { status: 401 }
      );
    }

    // اعتبارسنجی توکن
    const decoded = verifyToken(token);
    console.log('توکن دکد شده:', decoded); // دیباگ
    if (!decoded) {
      const response = NextResponse.json(
        { success: false, error: 'توکن نامعتبر است یا منقضی شده است' },
        { status: 401 }
      );
      response.cookies.set('adminToken', '', { maxAge: 0, path: '/' });
      return response;
    }

    // بررسی وجود سشن با توکن
    const session = await prisma.adminSession.findFirst({
      where: {
        adminId: decoded.adminId,
        tokenHash: token,
        isValid: true,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      const response = NextResponse.json(
        { success: false, error: 'سشن معتبر برای این توکن یافت نشد' },
        { status: 401 }
      );
      response.cookies.set('adminToken', '', { maxAge: 0, path: '/' });
      return response;
    }

    // غیرفعال کردن سشن
    await prisma.adminSession.updateMany({
      where: {
        adminId: decoded.adminId,
        tokenHash: token,
        isValid: true,
      },
      data: {
        isValid: false,
        expiresAt: new Date(),
      },
    });

    // به‌روزرسانی زمان لوگ‌اوت
    await prisma.admin.update({
      where: { id: decoded.adminId },
      data: { lastLogoutAt: new Date() },
    });

    // حذف کوکی
    const response = NextResponse.json(
      { success: true, message: 'با موفقیت از حساب خود خارج شدید' },
      { status: 200 }
    );
    response.cookies.set('adminToken', '', { maxAge: 0, path: '/' });

    return response;
  } catch (error) {
    console.error('خطای لوگ‌اوت:', error);
    const response = NextResponse.json(
      { success: false, error: 'خطای سرور در فرآیند خروج. لطفاً با پشتیبانی تماس بگیرید' },
      { status: 500 }
    );
    response.cookies.set('adminToken', '', { maxAge: 0, path: '/' });
    return response;
  }
}