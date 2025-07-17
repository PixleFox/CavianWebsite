import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient, TicketStatus, TicketPriority, TicketCategory } from '@prisma/client';
import { authenticateRequest } from '../../../../lib/api-utils';
import { rateLimitMiddleware } from '../../../../lib/rate-limiter';
import { z } from 'zod';

const prisma = new PrismaClient();

// Error messages in Farsi
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  FORBIDDEN: 'شما مجوز دسترسی به این منبع را ندارید.',
  NOT_FOUND: 'تیکت یافت نشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.',
  TICKET_NOT_FOUND: 'تیکت مورد نظر یافت نشد.'
} as const;

// Types for API responses
interface ErrorResponse {
  success: false;
  message: string;
  details?: Record<string, unknown>;
}

interface SuccessResponse<T = unknown> {
  success: true;
  [key: string]: unknown;
  data?: T;
}

// Utility functions for consistent responses
const errorResponse = (
  status: number, 
  message: string, 
  details?: Record<string, unknown>
): NextResponse<ErrorResponse> => {
  return NextResponse.json(
    { 
      success: false, 
      message, 
      ...(details && { details }) 
    } as ErrorResponse,
    { 
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
};

const successResponse = <T = unknown>(
  data: Omit<SuccessResponse<T>, 'success'>,
  status = 200
): NextResponse<SuccessResponse<T>> => {
  return NextResponse.json(
    { success: true, ...data } as SuccessResponse<T>,
    { 
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
};

// Input validation schemas
const createTicketSchema = z.object({
  subject: z.string().min(1, 'عنوان تیکت الزامی است'),
  description: z.string().min(1, 'توضیحات تیکت الزامی است'),
  category: z.nativeEnum(TicketCategory, {
    errorMap: () => ({ message: 'دسته‌بندی تیکت نامعتبر است' })
  }),
  priority: z.nativeEnum(TicketPriority).default('MEDIUM')
});

// Helper to get authenticated user from token
async function getAuthenticatedUser(request: Request) {
  const auth = await authenticateRequest(request);
  
  // If authentication fails, return null
  if (!auth.success) return null;
  
  // Return either admin or user based on what's available
  if (auth.adminId) {
    return {
      id: auth.adminId,
      role: 'ADMIN' as const,
      isAdmin: true
    };
  } else if (auth.userId) {
    return {
      id: auth.userId,
      role: 'USER' as const,
      isAdmin: false
    };
  }
  
  return null;
}

// GET /api/tickets - List tickets with filters
async function handleGet(request: NextRequest) {
  // Apply rate limiting for listing tickets
  const rateLimit = await rateLimitMiddleware(request, '/api/tickets', 'ticket', 'list');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorResponse(401, MESSAGES.UNAUTHORIZED);
  }
  
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') as TicketStatus | null;
  const priority = searchParams.get('priority') as TicketPriority | null;
  const category = searchParams.get('category') as TicketCategory | null;
  const assignedToMe = searchParams.get('assignedToMe') === 'true';
  const myTickets = searchParams.get('myTickets') === 'true';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '10');

  try {
    // Build the where conditions
    const whereConditions: {
      userId?: number;
      status?: TicketStatus;
      priority?: TicketPriority;
      category?: TicketCategory;
      assignedToId?: number | { equals: number | null };
    } = {};
    
    // Users can only see their own tickets
    // Admins can see all tickets, but can filter to see just their own with myTickets
    if (user.role !== 'ADMIN' || myTickets) {
      whereConditions.userId = user.id;
    }
    
    // Admins can filter by assigned tickets
    if (assignedToMe && user.role === 'ADMIN') {
      whereConditions.assignedToId = { equals: user.id };
    }
    
    // Apply filters
    if (status) whereConditions.status = status;
    if (priority) whereConditions.priority = priority;
    if (category) whereConditions.category = category;
    if (assignedToMe && user.role === 'ADMIN') {
      whereConditions.assignedToId = user.id;
    }

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where: whereConditions,
        include: {
          user: {
            select: { firstName: true, lastName: true, email: true }
          },
          assignedTo: {
            select: { firstName: true, lastName: true }
          },
          _count: {
            select: { messages: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ticket.count({ where: whereConditions })
    ]);

    return successResponse({
      tickets,
      pagination: {
        total,
        page,
        totalPages: Math.ceil(total / limit),
        limit
      }
    });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// POST /api/tickets - Create a new ticket
async function handlePost(request: NextRequest) {
  // Apply rate limiting for ticket creation
  const rateLimit = await rateLimitMiddleware(request, '/api/tickets', 'ticket', 'create');
  if (rateLimit.isRateLimited) return rateLimit.response;
  
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return errorResponse(401, MESSAGES.UNAUTHORIZED);
  }

  try {
    const body = await request.json();
    const validation = createTicketSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        errors: validation.error.errors
      });
    }

    const { subject, description, category, priority } = validation.data;

    // Verify user exists
    let userData;
    if (user.isAdmin) {
      const admin = await prisma.admin.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneNumber: true
        }
      });
      
      if (!admin) {
        return errorResponse(404, 'Admin not found');
      }
      userData = {
        ...admin,
        role: 'ADMIN' as const
      };
    } else {
      const userProfile = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneNumber: true,
          status: true
        }
      });
      
      if (!userProfile) {
        return errorResponse(404, 'User not found');
      }
      userData = {
        ...userProfile,
        role: 'USER' as const
      };
    }

    // Create the ticket
    const ticket = await prisma.ticket.create({
      data: {
        subject,
        description,
        category,
        priority,
        status: 'OPEN',
        userId: user.id,
        assignedToId: null
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true
          }
        },
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        messages: true
      }
    });

    console.log('Created ticket:', { 
      ticketId: ticket.id,
      userId: user.id,
      userType: user.isAdmin ? 'admin' : 'user',
      subject: ticket.subject,
      status: ticket.status
    });

    return successResponse({ 
      data: {
        ...ticket,
        messages: ticket.messages || [],
        createdBy: userData
      }
    }, 201);
  } catch (error) {
    console.error('Error creating ticket:', error);
    return errorResponse(500, 'خطای سرور در ایجاد تیکت');
  }
}

// Main request handlers
export async function GET(request: NextRequest) {
  return handleGet(request);
}

export async function POST(request: NextRequest) {
  return handlePost(request);
}
