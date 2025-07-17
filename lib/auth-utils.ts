import { SignJWT, jwtVerify } from 'jose';
import { NextRequest } from 'next/server';
import prisma from './prisma';
import { UserType } from './auth';

// Extend the Node.js global type to include the crypto property
declare global {
  interface Crypto {
    randomUUID(): string;
  }
}

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key');
const USER_TOKEN_NAME = 'user_auth_token';
const ADMIN_TOKEN_NAME = 'admin_auth_token';
const TOKEN_EXPIRY = '30d';

type UserPayload = {
  userId: number;
  role: UserType;
  sessionId: string; // UUID string from UserSession.id
};

export async function createAuthToken(userId: number, role: UserType, ipAddress: string = '0.0.0.0', userAgent: string = 'unknown') {
  try {
    console.log('Creating auth token for user:', { userId, role });
    
    // Create JWT token first
    const sessionId = crypto.randomUUID();
    const token = await new SignJWT({ 
      userId, 
      role, 
      sessionId 
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(TOKEN_EXPIRY)
      .sign(JWT_SECRET);

    console.log('Created JWT token');
    
    // Hash the JWT token for storage
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    
    // Invalidate any existing sessions
    await prisma.userSession.updateMany({
      where: { 
        userId,
        isActive: true 
      },
      data: { 
        isActive: false
      }
    });

    console.log('Invalidated existing sessions');

    // Create new session with the hashed token
    await prisma.userSession.create({
      data: {
        id: sessionId,
        userId,
        tokenHash,
        ipAddress,
        userAgent,
        expiresAt,
        isActive: true,
      }
    });

    console.log('Created new session:', { sessionId });
    return { token, sessionId };
  } catch (error) {
    console.error('Error creating auth token:', error);
    throw new Error('Failed to create authentication token');
  }
}

// Define the expected token payload shape
type TokenPayload = {
  userId: number;
  role: string;
  type?: string;
  sessionId?: string;
  iat?: number;
  exp?: number;
};

export async function verifyAuthToken(token: string, role: UserType): Promise<UserPayload | null> {
  try {
    console.log('Verifying token:', { token });
    
    // Verify JWT token
    const { payload } = await jwtVerify(token, JWT_SECRET);
    console.log('Decoded JWT payload:', payload);
    
    const { userId, role: tokenRole, type, sessionId } = payload as TokenPayload;

    // Verify required fields exist
    if (!userId || !tokenRole) {
      console.error('Missing required token fields:', { userId, tokenRole });
      return null;
    }
    
    // For backward compatibility, map 'CUSTOMER' to 'USER' role
    const mapLegacyRole = (role: string): UserType => {
      if (role === 'CUSTOMER') return 'USER';
      return role as UserType; // This will throw if role is not valid
    };

    // For backward compatibility, if type is 'user' and role is CUSTOMER
    if (type === 'user' && role === 'USER') {
      console.log('Using legacy token format with type=user');
      // For legacy tokens, we'll use the token itself to find the session
      const tokenHash = await hashToken(token);
      const session = await prisma.userSession.findFirst({
        where: {
          userId,
          tokenHash,
          expiresAt: { gt: new Date() },
          isActive: true
        },
        select: {
          id: true,
          userId: true
        }
      });
      
      if (!session) {
        console.error('No active session found for legacy token');
        return null;
      }
      
      // Return the session with the correct role type
      return {
        userId: session.userId,
        role: 'USER',
        sessionId: session.id
      };
    }

    // Map legacy role if needed and verify token role matches required role
    const mappedTokenRole = mapLegacyRole(tokenRole);
    if (mappedTokenRole !== role) {
      console.error('Role mismatch:', { tokenRole, mappedTokenRole, requiredRole: role });
      return null;
    }

    // Verify session exists and is valid
    const session = await prisma.userSession.findFirst({
      where: {
        id: sessionId,
        userId,
        expiresAt: { gt: new Date() },
        isActive: true
      },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        expiresAt: true
      }
    });

    if (!session) {
      console.error('No active session found for token');
      return null;
    }

    // Verify token hash matches
    const tokenHash = await hashToken(token);
    if (session.tokenHash !== tokenHash) {
      console.error('Token hash mismatch');
      return null;
    }
    
    console.log('Token verification successful');
    return { 
      userId: session.userId, 
      role, 
      sessionId: session.id 
    };
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

export async function invalidateSession(userId: number, sessionId?: string): Promise<string | null> {
  try {
    if (sessionId) {
      // Invalidate specific session
      await prisma.userSession.updateMany({
        where: { 
          id: sessionId,
          userId,
          isActive: true
        },
        data: { 
          isActive: false
        }
      });
      return null;
    } else {
      // Invalidate all active sessions for user
      await prisma.userSession.updateMany({
        where: { 
          userId,
          isActive: true 
        },
        data: { 
          isActive: false
        }
      });
      
      // Determine if this is an admin or regular user
      const isAdmin = await prisma.admin.findUnique({
        where: { id: userId },
        select: { id: true }
      });
      
      return isAdmin ? ADMIN_TOKEN_NAME : USER_TOKEN_NAME;
    }
  } catch (error) {
    console.error('Error invalidating session:', error);
    throw new Error('Failed to invalidate session');
  }
}

export function getAuthToken(request: NextRequest, role: UserType): string | undefined {
  const tokenName = role === 'ADMIN' ? ADMIN_TOKEN_NAME : USER_TOKEN_NAME;
  return request.cookies.get(tokenName)?.value;
}

// Helper function to get the appropriate token name based on user ID
export async function getTokenName(userId: number): Promise<string> {
  try {
    const isAdmin = await prisma.admin.findUnique({
      where: { id: userId },
      select: { id: true }
    });
    
    return isAdmin ? ADMIN_TOKEN_NAME : USER_TOKEN_NAME;
  } catch (error) {
    console.error('Error getting token name:', error);
    return USER_TOKEN_NAME; // Default to user token on error
  }
}

// Helper function to hash tokens
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
