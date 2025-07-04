import { NextResponse } from 'next/server';
import { verifyToken } from './auth'; // Both files are in the same directory

interface AuthResult {
  success: boolean;
  response?: NextResponse;
  adminId?: number; // Changed to number to match auth.ts
  error?: string;
}

export async function authenticateRequest(request: Request): Promise<AuthResult> {
  // Check for token in Authorization header first
  let token: string | null = null;
  const authHeader = request.headers.get('authorization');
  
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else {
    // Check for token in cookies
    const cookieHeader = request.headers.get('cookie');
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        acc[key] = value;
        return acc;
      }, {} as Record<string, string>);
      
      token = cookies['adminToken'] || null;
    }
  }

  if (!token) {
    return {
      success: false,
      response: NextResponse.json(
        { success: false, message: 'No authentication token provided' },
        { status: 401 }
      )
    };
  }

  try {
    const decoded = verifyToken(token);
    if (!decoded) {
      return {
        success: false,
        response: NextResponse.json(
          { success: false, message: 'Invalid or expired token' },
          { status: 401 }
        )
      };
    }

    return {
      success: true,
      adminId: decoded.adminId
    };
  } catch (error) {
    console.error('Token verification error:', error);
    return {
      success: false,
      response: NextResponse.json(
        { success: false, message: 'Token verification failed' },
        { status: 401 }
      )
    };
  }
}
