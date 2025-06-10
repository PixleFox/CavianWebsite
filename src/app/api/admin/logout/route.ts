import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/prisma';
import { verifyToken } from '../../../../../lib/auth';
import { handleError } from '../../../../../lib/error-handler';
import { SuccessMessages } from '../../../../../lib/success-messages';

export async function GET(request: NextRequest) {
  try {
    // Get token from cookies
    const token = request.cookies.get('adminToken')?.value;
    
    if (!token) {
      const response = NextResponse.json(
        { 
          success: false, 
          error: 'هیچ توکنی برای خروج یافت نشد',
          code: 'NO_TOKEN_FOUND'
        },
        { status: 401 }
      );
      response.cookies.set('adminToken', '', { 
        maxAge: 0, 
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
      });
      return response;
    }

    // Verify token
    const decoded = verifyToken(token);
    if (!decoded) {
      const response = NextResponse.json(
        { 
          success: false, 
          error: 'توکن نامعتبر است یا منقضی شده است',
          code: 'INVALID_OR_EXPIRED_TOKEN'
        },
        { status: 401 }
      );
      response.cookies.set('adminToken', '', { 
        maxAge: 0, 
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
      });
      return response;
    }

    // Check for valid session
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
        { 
          success: false, 
          error: 'سشن معتبر برای این توکن یافت نشد',
          code: 'INVALID_SESSION'
        },
        { status: 401 }
      );
      response.cookies.set('adminToken', '', { 
        maxAge: 0, 
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
      });
      return response;
    }

    // Invalidate session
    await prisma.$transaction([
      prisma.adminSession.updateMany({
        where: {
          adminId: decoded.adminId,
          tokenHash: token,
          isValid: true,
        },
        data: {
          isValid: false,
          expiresAt: new Date(),
        },
      }),
      prisma.admin.update({
        where: { id: decoded.adminId },
        data: { lastLogoutAt: new Date() },
      })
    ]);

    // Prepare success response
    const response = NextResponse.json(
      { 
        success: true, 
        message: SuccessMessages.LOGOUT_SUCCESS,
        data: {
          adminId: decoded.adminId,
          timestamp: new Date().toISOString()
        }
      },
      { status: 200 }
    );
    
    // Clear cookie
    response.cookies.set('adminToken', '', { 
      maxAge: 0, 
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });

    return response;
  } catch (error) {
    // Handle all errors through our error handler
    const response = handleError(error, request);
    // Ensure cookie is cleared even on error
    response.cookies.set('adminToken', '', { 
      maxAge: 0, 
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    return response;
  }
}