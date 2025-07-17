import { NextResponse } from 'next/server';
import { verifyToken } from './auth';

interface TokenPayload {
  userId?: number;
  adminId?: number;
  role: 'USER' | 'ADMIN' | 'OWNER';
  [key: string]: unknown;
}

interface AuthResult {
  success: boolean;
  response?: NextResponse;
  userId?: number;
  adminId?: number;
  role?: 'USER' | 'ADMIN' | 'OWNER';
  error?: string;
}

export async function authenticateRequest(request: Request): Promise<AuthResult> {
  console.log('=== Authentication Debug ===');
  console.log('Request URL:', request.url);
  console.log('Request Headers:', Object.fromEntries(request.headers.entries()));
  
  // Check for token in Authorization header first
  let token: string | null = null;
  let isAdminRoute = false;
  const authHeader = request.headers.get('authorization');
  
  // Determine if this is an admin route
  isAdminRoute = request.url.includes('/api/admin/');
  
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
    console.log('Found token in Authorization header');
  } else {
    console.log('No Bearer token in Authorization header');
    
    // Check for token in cookies
    const cookieHeader = request.headers.get('cookie');
    console.log('Raw Cookie Header:', cookieHeader);
    
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').reduce((acc: Record<string, string>, cookie) => {
        const [name, value] = cookie.trim().split('=');
        if (name && value) {
          acc[name.trim()] = decodeURIComponent(value);
        }
        return acc;
      }, {});
      
      console.log('Parsed Cookies:', cookies);
      
      // For admin routes, only accept admin tokens
      if (isAdminRoute) {
        if (cookies['adminToken']) {
          token = cookies['adminToken'];
          console.log('Found admin token in cookies');
        } else {
          console.log('Admin route accessed without admin token');
          return {
            success: false,
            response: NextResponse.json(
              { success: false, message: 'Admin authentication required' },
              { status: 401 }
            )
          };
        }
      } 
      // For non-admin routes, accept either token type
      else if (cookies['auth_token']) {
        token = cookies['auth_token'];
        console.log('Found user token in cookies');
      } else {
        console.log('No auth token found in cookies');
      }
    } else {
      console.log('No cookies found in request');
    }
  }
  
  if (!token) {
    console.log('No token found in request');
    return {
      success: false,
      response: NextResponse.json(
        { success: false, message: 'No authentication token provided' },
        { status: 401 }
      )
    };
  }
  
  console.log('Extracted token from cookies:', token ? 'Token exists' : 'No token');
  
  try {
    console.log('Verifying token...');
    console.log('Token:', token ? `${token.substring(0, 10)}...` : 'No token provided');
    
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not defined in environment variables');
      return {
        success: false,
        response: NextResponse.json(
          { success: false, message: 'Server configuration error' },
          { status: 500 }
        )
      };
    }
    
    const decoded = verifyToken(token) as TokenPayload | null;
    console.log('Token payload:', decoded);
    
    if (!decoded) {
      console.error('Token verification failed');
      return {
        success: false,
        response: NextResponse.json(
          { success: false, message: 'Invalid or expired token' },
          { status: 401 }
        )
      };
    }
    
    // For admin routes, we need to ensure the token is an admin token
    const isAdminToken = decoded.role === 'ADMIN' || decoded.role === 'OWNER';
    
    if (isAdminRoute && !isAdminToken) {
      console.error('Admin route accessed with non-admin token');
      return {
        success: false,
        response: NextResponse.json(
          { success: false, message: 'Insufficient permissions' },
          { status: 403 }
        )
      };
    }
    
    const userId = decoded.userId;
    const adminId = decoded.adminId || (isAdminToken ? decoded.userId : undefined);
    
    if ((!userId && !adminId) || (isAdminRoute && !adminId)) {
      return {
        success: false,
        response: NextResponse.json(
          { success: false, message: 'Invalid token: missing user ID' },
          { status: 401 }
        )
      };
    }

    return {
      success: true,
      userId: isAdminRoute ? undefined : userId,
      adminId: isAdminRoute ? adminId : undefined,
      role: decoded.role
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
