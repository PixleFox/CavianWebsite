import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/prisma';
import { UserType } from '../../../../../lib/auth';
import jwt from 'jsonwebtoken';

// Interface for the decoded token
interface DecodedToken {
  userId?: number;
  adminId?: number;
  role: UserType | 'OWNER';
  iat?: number;
  exp?: number;
  phoneNumber?: string;
}

export async function POST(request: NextRequest) {
  try {
    // 1. Get token from cookies
    const token = request.cookies.get('adminToken')?.value;
    
    if (!token) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'No authentication token found',
          code: 'NO_TOKEN_FOUND'
        },
        { status: 401 }
      );
    }

    // 2. Verify the token
    console.log('Token to verify:', token ? `${token.substring(0, 10)}...` : 'No token provided');
    
    let decoded: DecodedToken | null = null;
    try {
      // First try to decode the token to see its structure
      const unverified = jwt.decode(token) as DecodedToken | null;
      console.log('Decoded token content:', unverified);
      
      if (unverified) {
        // Check if this is an admin/owner token
        const isAdminToken = (unverified.role === 'ADMIN' || unverified.role === 'OWNER') && 
                           (unverified.adminId || unverified.userId);
        
        if (isAdminToken) {
          decoded = {
            ...unverified,
            userId: unverified.userId || unverified.adminId,
            role: unverified.role as UserType
          };
          console.log('Accepted token with role:', decoded.role);
        } else {
          console.error('Token is not an admin/owner token:', { role: unverified.role });
          return NextResponse.json(
            { 
              success: false, 
              error: 'Invalid token - admin privileges required',
              code: 'ADMIN_ACCESS_REQUIRED'
            },
            { status: 403 }
          );
        }
      } else {
        console.error('Could not decode token');
        return NextResponse.json(
          { 
            success: false, 
            error: 'Invalid token format',
            code: 'INVALID_TOKEN_FORMAT'
          },
          { status: 401 }
        );
      }
    } catch (error) {
      console.error('Error during token verification:', error);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error during token verification',
          code: 'TOKEN_VERIFICATION_ERROR',
          debug: {
            error: error instanceof Error ? error.message : 'Unknown error',
            tokenExists: !!token,
            tokenPrefix: token ? `${token.substring(0, 10)}...` : 'No token'
          }
        },
        { status: 401 }
      );
    }
    
    // At this point we have a valid admin/owner token
    const adminId = decoded.userId || decoded.adminId;
    if (!adminId) {
      console.error('No admin ID found in token');
      return NextResponse.json(
        { 
          success: false, 
          error: 'Invalid token - missing admin ID',
          code: 'INVALID_TOKEN_DATA'
        },
        { status: 401 }
      );
    }

    // 3. Invalidate the session
    try {
      // 3. Find and invalidate the admin session
      // Find active session for this admin
      const sessions = await prisma.adminSession.findMany({
        where: {
          adminId: adminId,
          isValid: true,
          expiresAt: { gt: new Date() },
        },
        orderBy: {
          expiresAt: 'desc', // Get the most recent session first
        },
        take: 1, // Only get the most recent session
      });
      
      const session = sessions[0]; // Get the first (and only) session

      if (session) {
        await prisma.adminSession.update({
          where: { id: session.id },
          data: {
            isValid: false,
            expiresAt: new Date()
          }
        });
      }

      // 5. Update admin's last logout time
      await prisma.admin.update({
        where: { id: adminId },
        data: { lastLogoutAt: new Date() },
      });
    } catch (error) {
      console.error('Error during session invalidation:', error);
      // Continue with logout even if invalidation fails
    }

    // 4. Create success response
    const response = NextResponse.json(
      { 
        success: true, 
        message: 'Logout successful',
        code: 'LOGOUT_SUCCESS',
        data: {
          adminId: adminId,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 200 }
    );

    // 5. Clear all auth cookies
    const cookieOptions = {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict' as const,
      maxAge: 0
    };

    response.cookies.set('adminToken', '', cookieOptions);
    response.cookies.set('auth_token', '', cookieOptions);
    response.cookies.set('admin_auth_token', '', cookieOptions);

    return response;

  } catch (error) {
    // Handle unexpected errors
    console.error('Unexpected error during logout:', error);
    
    // Create error response
    const response = NextResponse.json(
      { 
        success: false, 
        error: 'An unexpected error occurred',
        code: 'INTERNAL_SERVER_ERROR'
      },
      { status: 500 }
    );

    // Clear cookies on error too
    response.cookies.set('adminToken', '', { 
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 0
    });

    return response;
  }
}