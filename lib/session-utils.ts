import prisma from './prisma';
import { generateToken, verifyToken, UserType } from './auth';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

const TOKEN_NAMES = {
  USER: 'user_auth_token',
  ADMIN: 'admin_auth_token'
} as const;



export async function createUserSession(userId: number, ipAddress: string, userAgent: string = '') {
  const token = generateToken(userId, 'USER' as UserType);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  // Create user session in database
  const session = await prisma.userSession.create({
    data: {
      tokenHash: await hashToken(token),
      ipAddress,
      userAgent: userAgent || '',
      expiresAt,
      userId,
      isActive: true
    }
  });

  // Return the token and session, let the route handler create the response
  return { token, session };
}

export async function createAdminSession(adminId: number, ipAddress: string, userAgent: string = '') {
  const token = generateToken(adminId, 'ADMIN' as UserType);
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours for admin

  // Create admin session in database
  const session = await prisma.adminSession.create({
    data: {
      tokenHash: await hashToken(token),
      ipAddress,
      userAgent: userAgent || '',
      expiresAt,
      adminId,
      isValid: true
    }
  });

  // Return the token and session, let the route handler create the response
  return { token, session };
}

export async function verifyUserSession(token: string) {
  try {
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'USER') return null;

    const session = await prisma.userSession.findFirst({
      where: {
        tokenHash: await hashToken(token),
        isActive: true,
        expiresAt: { gt: new Date() },
        userId: payload.userId
      }
    });

    if (session) {
      // Update last activity
      await prisma.userSession.update({
        where: { id: session.id },
        data: { lastActivityAt: new Date() }
      });
      return { userId: payload.userId, role: 'USER' as const, sessionId: session.id };
    }
    return null;
  } catch (error) {
    console.error('Session verification failed:', error);
    return null;
  }
}

export async function verifyAdminSession(token: string) {
  try {
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'ADMIN') return null;

    const session = await prisma.adminSession.findFirst({
      where: {
        tokenHash: await hashToken(token),
        isValid: true,
        expiresAt: { gt: new Date() },
        adminId: payload.userId
      }
    });

    return session ? { userId: payload.userId, role: 'ADMIN' as const, sessionId: session.id } : null;
  } catch (error) {
    console.error('Admin session verification failed:', error);
    return null;
  }
}

export async function invalidateUserSession(userId: number, sessionId?: string) {
  // Build the where clause based on whether we have a sessionId
  const whereClause: Prisma.UserSessionWhereInput = sessionId 
    ? { id: sessionId, userId }
    : { userId };

  // Deactivate the session(s)
  await prisma.userSession.updateMany({
    where: whereClause,
    data: { isActive: false }
  });
}

export async function invalidateAdminSession(adminId: number, sessionId?: string) {
  // Build the where clause with proper typing for Prisma
  const whereClause: Prisma.AdminSessionWhereInput = sessionId 
    ? { 
        id: parseInt(sessionId, 10), // Convert string ID to number
        adminId: { equals: adminId } 
      }
    : { adminId: { equals: adminId } };

  // Deactivate the session(s)
  await prisma.adminSession.updateMany({
    where: whereClause,
    data: { isValid: false }
  });
}

export function getUserToken(request: NextRequest): string | undefined {
  return request.cookies.get(TOKEN_NAMES.USER)?.value;
}

export function getAdminToken(request: NextRequest): string | undefined {
  return request.cookies.get(TOKEN_NAMES.ADMIN)?.value;
}

async function hashToken(token: string): Promise<string> {
  // Simple hash function for token storage
  const encoder = new TextEncoder();
  const data = encoder.encode(token + (process.env.TOKEN_SALT || ''));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
