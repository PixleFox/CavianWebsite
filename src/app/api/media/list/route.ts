import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '../../../../../lib/auth';
import { listMedia } from '../../../../../lib/media-utils';

export async function GET(request: NextRequest) {
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

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const search = searchParams.get('search') || '';

    // Get paginated media list
    const result = await listMedia({
      page,
      limit,
      search,
    });

    return NextResponse.json({
      success: true,
      data: result.items,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('Error listing media:', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'خطا در دریافت لیست رسانه‌ها' 
      },
      { status: 500 }
    );
  }
}
