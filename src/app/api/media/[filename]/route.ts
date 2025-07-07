import { NextRequest, NextResponse } from 'next/server';
import { deleteFile } from '@lib/media-utils';
import { verifyToken } from '../../../../../lib/auth';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { filename: string } }
) {
  try {
    // Check for token in Authorization header first
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else {
      // Check for token in cookies
      const cookieHeader = request.headers.get('cookie');
      if (cookieHeader) {
        const cookies = Object.fromEntries(
          cookieHeader.split(';').map(c => {
            const [key, ...values] = c.trim().split('=');
            return [key, values.join('=')];
          })
        );
        token = cookies['adminToken'] || null;
      }
    }
    
    if (!token) {
      return NextResponse.json(
        { success: false, message: 'توکن احراز هویت یافت نشد' },
        { status: 401 }
      );
    }

    const decoded = verifyToken(token);
    if (!decoded || !decoded.adminId) {
      return NextResponse.json(
        { success: false, message: 'توکن نامعتبر است' },
        { status: 401 }
      );
    }

    const { filename } = params;
    if (!filename) {
      return NextResponse.json(
        { success: false, message: 'نام فایل الزامی است' },
        { status: 400 }
      );
    }

    const result = await deleteFile(filename);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: result.error || 'خطا در حذف فایل' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'فایل با موفقیت حذف شد'
    });
  } catch (error) {
    console.error('Delete error:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور در حذف فایل' },
      { status: 500 }
    );
  }
}
