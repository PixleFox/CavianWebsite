import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { authenticateRequest } from '@lib/api-utils';
import { ticketRateLimiter } from '@lib/rate-limiter';
import { z } from 'zod';

const prisma = new PrismaClient();

// Error messages in Farsi
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  FORBIDDEN: 'شما مجوز دسترسی به این منبع را ندارید.',
  NOT_FOUND: 'تیکت یافت نشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.',
  TICKET_NOT_FOUND: 'تیکت مورد نظر یافت نشد.',
  TICKET_CLOSED: 'این تیکت بسته شده است و نمی‌توان به آن پاسخی اضافه کرد.'
} as const;

// Helper to get authenticated user from token
async function getAuthenticatedUser(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return null;
  
  return {
    id: auth.adminId!,
    role: 'ADMIN' // This matches the orders API pattern
  };
}

// Helper functions for consistent responses
function errorResponse(status: number, message: string, details?: Record<string, unknown>) {
  return NextResponse.json(
    { 
      success: false,
      message,
      ...(details && { details }) 
    },
    { 
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
}

function successResponse(data: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    { 
      success: true,
      data 
    },
    { 
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
}

// Input validation schema
const createMessageSchema = z.object({
  content: z.string().min(1, 'متن پیام نمی‌تواند خالی باشد'),
  attachments: z.array(z.string()).optional().default([])
});

// GET /api/tickets/[id]/messages - Get all messages for a ticket
async function handleGet(request: NextRequest, context: { params: { id: string } }) {
  // Await the params object first
  const resolvedParams = await context.params;
  const ticketId = resolvedParams.id;
  
  // Apply rate limiting
  const rateLimit = await ticketRateLimiter.listMessages(request, ticketId);
  if (rateLimit) return rateLimit;
  
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorResponse(401, MESSAGES.UNAUTHORIZED);
  }
  
  try {
    // Check if ticket exists and user has permission
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { userId: true }
    });

    if (!ticket) {
      return errorResponse(404, MESSAGES.TICKET_NOT_FOUND);
    }

    // Only ticket owner or admin can view messages
    if (user.role !== 'ADMIN' && ticket.userId !== user.id) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }

    const messages = await prisma.ticketMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        admin: { select: { firstName: true, lastName: true, email: true } }
      }
    });

    return successResponse({ messages });
  } catch (error) {
    console.error('Error fetching ticket messages:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// POST /api/tickets/[id]/messages - Add a new message to a ticket
async function handlePost(request: NextRequest, context: { params: { id: string } }) {
  // Await the params object first
  const resolvedParams = await context.params;
  const ticketId = resolvedParams.id;
  
  // Apply rate limiting
  const rateLimit = await ticketRateLimiter.createMessage(request, ticketId);
  if (rateLimit) return rateLimit;
  
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorResponse(401, MESSAGES.UNAUTHORIZED);
  }
  
  try {
    // Check if ticket exists and is open
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId }
    });

    if (!ticket) {
      return errorResponse(404, MESSAGES.TICKET_NOT_FOUND);
    }

    // Check if ticket is closed
    if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED') {
      return errorResponse(400, MESSAGES.TICKET_CLOSED);
    }

    // Check if user has permission to post to this ticket
    if (user.role !== 'ADMIN' && ticket.userId !== user.id) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }

    // Validate request body
    const body = await request.json();
    const validation = createMessageSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        errors: validation.error.errors
      });
    }

    const { content, attachments } = validation.data;
    const isAdmin = user.role === 'ADMIN';

    // Create the message
    const message = await prisma.ticketMessage.create({
      data: {
        content,
        type: isAdmin ? 'ADMIN' : 'USER',
        attachments,
        ticketId,
        ...(isAdmin 
          ? { adminId: user.id }
          : { userId: user.id }
        )
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        admin: { select: { firstName: true, lastName: true, email: true } }
      }
    });

    // Update ticket status if needed
    let statusUpdate = {};
    if (isAdmin) {
      statusUpdate = { status: 'AWAITING_RESPONSE' };
    } else {
      statusUpdate = { status: 'IN_PROGRESS' };
    }

    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        ...statusUpdate,
        updatedAt: new Date()
      }
    });

    return successResponse({ message }, 201);
  } catch (error) {
    console.error('Error creating ticket message:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// Main request handlers
export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    return await handleGet(request, context);
  } catch (error) {
    console.error('Error in GET messages handler:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    return await handlePost(request, context);
  } catch (error) {
    console.error('Error in POST messages handler:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}
