import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { NextRequest, NextResponse } from 'next/server';

export type UserType = 'USER' | 'ADMIN';

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

// Compare password with hash
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

// Generate JWT token
export function generateToken(userId: number, role: UserType = 'USER'): string {
  // Ensure role is always set, default to 'USER' if not provided
  const tokenRole = role || 'USER';
  
  const payload = {
    userId,
    role: tokenRole,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days
  };
  
  console.log('Generating token with payload:', payload);
  
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }
  
  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );
}

// Verify JWT token
export function verifyToken(token: string): { userId?: number; adminId?: number; role: UserType } | null {
  try {
    console.log('Verifying token...');
    console.log('Token:', token ? `${token.substring(0, 10)}...` : 'No token provided');
    
    if (!token) {
      console.error('No token provided for verification');
      return null;
    }

    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not defined in environment variables');
      return null;
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256']
    });
    
    console.log('Token payload:', payload);
    
    if (typeof payload === 'string') {
      console.error('Token payload is a string, expected an object');
      return null;
    }
    
    // Check token expiration
    if (payload.exp && Date.now() >= payload.exp * 1000) {
      console.error('Token has expired');
      return null;
    }
    
    // Define a type for the payload with all possible fields
    type TokenPayload = {
      userId?: number | string;
      user_id?: number | string;
      adminId?: number | string;
      admin_id?: number | string;
      role?: string;
      iat?: number;
      exp?: number;
      [key: string]: unknown;
    };

    const tokenPayload = payload as TokenPayload;
    
    // If role is missing, try to determine it from the token type
    if (!tokenPayload.role) {
      if ('adminId' in tokenPayload || 'admin_id' in tokenPayload) {
        tokenPayload.role = 'ADMIN';
      } else if ('userId' in tokenPayload || 'user_id' in tokenPayload) {
        tokenPayload.role = 'USER';
      } else {
        console.error('Cannot determine user role from token');
        return null;
      }
    }
    
    // Handle both camelCase and snake_case user ID fields
    const userId = tokenPayload.userId !== undefined ? Number(tokenPayload.userId) :
                 tokenPayload.user_id !== undefined ? Number(tokenPayload.user_id) : undefined;
                 
    const adminId = tokenPayload.adminId !== undefined ? Number(tokenPayload.adminId) :
                  tokenPayload.admin_id !== undefined ? Number(tokenPayload.admin_id) : undefined;
    
    // Default role to USER if not specified
    const role = payload.role || 'USER';
    
    const result = {
      ...(userId !== undefined && { userId }),
      ...(adminId !== undefined && { adminId }),
      role: role as UserType
    };
    
    console.log('Token verification successful. User info:', result);
    return result;
    
  } catch (error: unknown) {
    // Type-safe error handling
    const errorInfo: Record<string, unknown> = {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown error',
      date: new Date().toISOString()
    };
    
    // Add expiredAt if it exists in the error object
    if (error && typeof error === 'object' && 'expiredAt' in error) {
      errorInfo.expiredAt = (error as { expiredAt?: unknown }).expiredAt;
    }
    
    console.error('Token verification failed:', errorInfo);
    return null;
  }
}

// Generate OTP
export function generateOTP(length: number = 6): string {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}

// Check if user is authenticated from request headers
export function isAuthenticated(request: NextRequest, userType: UserType): boolean {
  const token = getTokenFromRequest(request, userType);
  if (!token) return false;
  
  const payload = verifyToken(token);
  return !!(payload && payload.role === userType);
}

// Get current user from request headers
export function getCurrentUser(request: NextRequest, userType: UserType) {
  const token = getTokenFromRequest(request, userType);
  if (!token) return null;
  
  const payload = verifyToken(token);
  return (payload && payload.role === userType) ? payload : null;
}

// Extract token from request headers
function getTokenFromRequest(request: NextRequest, userType: UserType): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  
  const cookieName = userType === 'ADMIN' ? 'admin_auth_token' : 'user_auth_token';
  const cookie = request.cookies.get(cookieName)?.value;
  return cookie || null;
}

// Create auth response with token cookie
export function createAuthResponse(token: string, userType: UserType, status: number = 200) {
  const response = NextResponse.json(
    { success: true },
    { status }
  );

  // Set the auth cookie
  response.cookies.set({
    name: userType === 'ADMIN' ? 'admin_auth_token' : 'user_auth_token',
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: userType === 'ADMIN' ? '/admin' : '/',
    maxAge: userType === 'ADMIN' ? 8 * 60 * 60 : 30 * 24 * 60 * 60 // 8h for admin, 30d for users
  });

  return response;
}

// Create logout response
export function createLogoutResponse(userType: UserType) {
  const response = NextResponse.json(
    { success: true },
    { status: 200 }
  );

  // Clear the auth cookie
  response.cookies.delete(userType === 'ADMIN' ? 'admin_auth_token' : 'user_auth_token');
  return response;
}