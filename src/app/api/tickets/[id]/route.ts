import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient, TicketStatus, TicketPriority } from '@prisma/client';
import { authenticateRequest } from '../../../../../lib/api-utils';
import { ticketRateLimiter } from '../../../../../lib/rate-limiter';
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
  INVALID_STATUS: 'وضعیت تیکت نامعتبر است.'
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

// Input validation schemas
const updateTicketSchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  priority: z.nativeEnum(TicketPriority).optional(),
  assignedToId: z.number().int().positive().optional().nullable(),
  subject: z.string().min(1, 'عنوان تیکت الزامی است').optional(),
  description: z.string().min(1, 'توضیحات تیکت الزامی است').optional()
});

// GET /api/tickets/[id] - Get a single ticket
async function handleGet(request: NextRequest, context: { params: { id: string } }) {
  // Await the params object first
  const resolvedParams = await context.params;
  const ticketId = resolvedParams.id;
  
  // Apply rate limiting
  const rateLimit = await ticketRateLimiter.detail(request, ticketId);
  if (rateLimit) return rateLimit;
  
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorResponse(401, MESSAGES.UNAUTHORIZED);
  }
  
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true, phoneNumber: true }
        },
        assignedTo: {
          select: { firstName: true, lastName: true, email: true }
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { firstName: true, lastName: true, email: true } },
            admin: { select: { firstName: true, lastName: true, email: true } }
          }
        }
      }
    });

    if (!ticket) {
      return errorResponse(404, MESSAGES.TICKET_NOT_FOUND);
    }

    // Check if user has permission to view this ticket
    if (user.role !== 'ADMIN' && ticket.userId !== user.id) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }

    return successResponse({ ticket });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// PATCH /api/tickets/[id] - Update a ticket
export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
) {
  console.log('🔵 PATCH /api/tickets/[id] - Start');
  
  // Helper function to create a proper Response
  type ResponseData = {
    error?: string;
    details?: unknown;
    ticket?: unknown;
  };
  
  const createResponse = (status: number, data: ResponseData) => {
    console.log(`🟢 Sending ${status} response:`, JSON.stringify(data).substring(0, 200));
    return NextResponse.json(data, { status });
  };
  
  // Helper to log and return error
  const logAndReturnError = (status: number, message: string, details?: unknown) => {
    console.error(`🔴 Error ${status}: ${message}`, details || '');
    return createResponse(status, { error: message, ...(details ? { details } : {}) });
  };

  try {
    // Get ticket ID
    console.log('🔵 Getting ticket ID from params');
    const params = await context.params;
    console.log('🔵 Params:', params);
    const ticketId = params.id;
    
    if (!ticketId) {
      console.error('❌ No ticket ID provided');
      return logAndReturnError(400, 'شناسه تیکت نامعتبر است');
    }
    console.log('🔵 Processing ticket ID:', ticketId);
    
    // Authentication
    console.log('🔵 Authenticating user');
    const user = await getAuthenticatedUser(request);
    if (!user) {
      console.error('❌ Unauthorized access');
      return logAndReturnError(401, MESSAGES.UNAUTHORIZED);
    }
    console.log('🔵 Authenticated as user:', user.id, user.role);

    // Parse and validate request body
    console.log('🔵 Parsing request body');
    let body;
    try {
      body = await request.json();
      console.log('🔵 Request body:', JSON.stringify(body).substring(0, 200));
    } catch (error) {
      console.error('❌ Error parsing JSON:', error);
      return logAndReturnError(400, 'فرمت درخواست نامعتبر است');
    }

    console.log('🔵 Validating request data');
    const validation = updateTicketSchema.safeParse(body);
    if (!validation.success) {
      console.error('❌ Validation failed:', validation.error.errors);
      return logAndReturnError(400, MESSAGES.INVALID_INPUT, {
        errors: validation.error.errors
      });
    }
    console.log('✅ Request data validated');

    // Check ticket existence and permissions
    console.log(`🔵 Fetching ticket ${ticketId}`);
    const existingTicket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, status: true }
    });
    
    if (!existingTicket) {
      console.error(`❌ Ticket not found: ${ticketId}`);
      return logAndReturnError(404, MESSAGES.TICKET_NOT_FOUND);
    }
    console.log('✅ Ticket found:', existingTicket);

    // Authorization
    console.log('🔵 Checking authorization');
    if (user.role !== 'ADMIN' && existingTicket.userId !== user.id) {
      console.error(`❌ Forbidden: User ${user.id} cannot modify ticket ${ticketId}`);
      return logAndReturnError(403, MESSAGES.FORBIDDEN);
    }
    console.log('✅ User authorized');

    // Prepare update data
    console.log('🔵 Preparing update data');
    let updateData = { ...validation.data };
    
    // For non-admin users, only allow specific fields
    if (user.role !== 'ADMIN') {
      const allowedFields = ['description', 'subject'];
      updateData = Object.keys(updateData)
        .filter(key => allowedFields.includes(key))
        .reduce((obj, key) => ({
          ...obj,
          [key]: updateData[key as keyof typeof updateData]
        }), {});

      if (Object.keys(updateData).length === 0) {
        console.error('❌ No valid fields to update for non-admin user');
        return logAndReturnError(400, 'هیچ فیلد معتبری برای به‌روزرسانی وجود ندارد');
      }
    }
    console.log('✅ Update data prepared:', updateData);

    // Update the ticket
    console.log('🔄 Updating ticket in database');
    try {
      const updatedTicket = await prisma.ticket.update({
        where: { id: ticketId },
        data: updateData,
        include: {
          assignedTo: user.role === 'ADMIN' ? {
            select: { id: true, firstName: true, lastName: true }
          } : false,
          user: {
            select: { id: true, firstName: true, lastName: true, email: true }
          }
        }
      });
      
      console.log('✅ Ticket updated successfully');
      return createResponse(200, { ticket: updatedTicket });
      
    } catch (dbError) {
      console.error('❌ Database error:', dbError);
      return logAndReturnError(500, 'خطا در به‌روزرسانی تیکت در پایگاه داده');
    }

  } catch (error) {
    console.error('❌ Unexpected error in PATCH /api/tickets/[id]:', error);
    return logAndReturnError(500, MESSAGES.INTERNAL_ERROR);
  } finally {
    console.log('🔵 PATCH /api/tickets/[id] - End');
  }
}

// DELETE /api/tickets/[id] - Delete a ticket (soft delete)
async function handleDelete(request: NextRequest, context: { params: { id: string } }) {
  // Await the params object first
  const resolvedParams = await context.params;
  const ticketId = resolvedParams.id;
  
  // Apply rate limiting
  const rateLimit = await ticketRateLimiter.delete(request, ticketId);
  if (rateLimit) return rateLimit;
  
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorResponse(401, MESSAGES.UNAUTHORIZED);
  }
  
  try {
    // Check if ticket exists
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId }
    });

    if (!ticket) {
      return errorResponse(404, MESSAGES.TICKET_NOT_FOUND);
    }

    // Only admin or the ticket owner can delete
    if (user.role !== 'ADMIN' && ticket.userId !== user.id) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }

    // Soft delete
    await prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'CLOSED', closedAt: new Date() }
    });

    return successResponse({ success: true });
  } catch (error) {
    console.error('Error deleting ticket:', error);
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
    console.error('Error in GET handler:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// PATCH handler is now implemented directly above

export async function DELETE(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    return await handleDelete(request, context);
  } catch (error) {
    console.error('Error in DELETE handler:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}
