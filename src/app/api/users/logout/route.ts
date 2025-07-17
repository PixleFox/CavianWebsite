import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken, invalidateSession } from '../../../../../lib/auth-utils';

// Helper to create a response with cleared cookies
const createClearedCookiesResponse = (status: number, message: string, success: boolean, requestId: string) => {
  const response = NextResponse.json(
    { 
      success,
      message,
      requestId,
      timestamp: new Date().toISOString()
    },
    { 
      status
    }
  );

  // Clear all possible auth cookies
  const cookies = [
    'auth_token',
    'userToken',
    'user_auth_token',
    'admin_auth_token'
  ];

  cookies.forEach(cookie => {
    response.cookies.set({
      name: cookie,
      value: '',
      expires: new Date(0),
      path: '/',
      httpOnly: true,
      sameSite: 'lax'
    });
  });

  return response;
};

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(2, 8);
  
  const debugLog = (message: string, data?: unknown) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEBUG][${new Date().toISOString()}][${requestId}] ${message}`, data || '');
    }
  };
  
  try {
    debugLog('=== START LOGOUT REQUEST ===');
    debugLog('Request URL:', request.url);
    debugLog('Request method:', request.method);
    debugLog('Request headers:', Object.fromEntries(request.headers.entries()));
    
    // Get all cookies and log them
    const allCookies = request.cookies.getAll();
    debugLog('All cookies:', allCookies.map(c => ({
      name: c.name,
      value: c.value ? '***' + c.value.slice(-4) : null
    })));
    
    // Get the auth token from cookies (check all possible cookie names)
    const userToken = request.cookies.get('userToken')?.value;
    const authToken = request.cookies.get('auth_token')?.value;
    const userAuthToken = request.cookies.get('user_auth_token')?.value;
    const token = userToken || authToken || userAuthToken;
    
    debugLog('Token check:', {
      hasUserToken: !!userToken,
      hasAuthToken: !!authToken,
      hasUserAuthToken: !!userAuthToken,
      tokenLength: token?.length,
      tokenPrefix: token ? token.substring(0, 10) + '...' : null
    });
    
    // If there's no token, the user is already logged out
    if (!token) {
      debugLog('No valid auth token found in cookies');
      return createClearedCookiesResponse(
        200,
        'شما قبلا خارج شده‌اید',
        true,
        requestId
      );
    }

    try {
      // Verify the token to get the session ID
      debugLog('Starting token verification...');
      let payload;
      try {
        debugLog('Calling verifyAuthToken...');
        payload = await verifyAuthToken(token, 'USER');
        debugLog('Token verification completed', { 
          hasPayload: !!payload,
          userId: payload?.userId,
          sessionId: payload?.sessionId ? '***' + payload.sessionId.slice(-4) : null
        });
        
        // Invalidate the session on the server side if payload exists
        if (payload) {
          debugLog('Starting session invalidation...', {
            userId: payload.userId,
            sessionId: '***' + payload.sessionId.slice(-4)
          });
          
          try {
            await invalidateSession(payload.userId, payload.sessionId);
            debugLog('Session invalidation successful');
          } catch (invalidateError) {
            debugLog('Error during session invalidation:', invalidateError);
            // Continue with logout even if invalidation fails
          }
        } else {
          debugLog('No payload returned from verifyAuthToken');
        }
      } catch (error) {
        debugLog('Error during token verification:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        // Continue with logout even if verification fails
      }
    } catch (error) {
      console.error('Error during session invalidation:', error);
      // Continue with logout even if there's an error
    }

    // Always return a response with cleared cookies, even if token verification failed
    return createClearedCookiesResponse(
      200,
      'خروج با موفقیت انجام شد',
      true,
      requestId
    );
  } catch (error) {
    debugLog('Error during logout:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Return a response with cleared cookies even on error
    return createClearedCookiesResponse(
      200,
      'خطا در خروج از حساب کاربری',
      false,
      requestId
    );
  }
}
