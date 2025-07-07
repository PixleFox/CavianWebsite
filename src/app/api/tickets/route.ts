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
  // If authentication fails or adminId is missing, return null
  if (!auth.success || !auth.adminId) return null;
  
  return {
    id: auth.adminId, // This is now guaranteed to be a number
    role: 'ADMIN' as const
  };
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
      assignedToId?: number;
    } = {};
    
    // Admin can see all tickets, users can only see their own
    if (user.role !== 'ADMIN' || myTickets) {
      whereConditions.userId = user.id;
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
  
      // 1. Get admin user details
      const adminUser = await prisma.admin.findUnique({
        where: { id: user.id },
        select: { 
          id: true,
          firstName: true, 
          lastName: true, 
          email: true, 
          phoneNumber: true 
        }
      });

      if (!adminUser) {
        return errorResponse(404, 'Admin user not found');
      }

      // 2. Get or create user profile (without creating a login)
      let userProfile = await prisma.user.findUnique({
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
        // Create a minimal user profile with all required fields
        const userData = {
          id: user.id,
          firstName: adminUser.firstName || 'User',
          lastName: adminUser.lastName || String(user.id).slice(0, 6),
          email: adminUser.email || `user-${user.id}@temporary.com`,
          phoneNumber: adminUser.phoneNumber || '',
          passwordHash: 'temporary-password-needs-reset',
          role: 'CUSTOMER' as const,
          status: 'ACTIVE' as const,
          emailVerified: false,
          phoneVerified: false,
          level: 1,
          receiveNewsletter: false,
          // Add other required fields with defaults
          fullName: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          // Add other fields required by your schema
          // ...
        };

        userProfile = await prisma.user.create({
          data: userData,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            status: true
          }
        });
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
          }
        }
      });

      // Prepare response data
      let responseData;
      
      if (userProfile) {
        const safeUserData = {
          id: userProfile.id,
          firstName: userProfile.firstName,
          lastName: userProfile.lastName,
          email: userProfile.email,
          phoneNumber: userProfile.phoneNumber,
          status: userProfile.status
        };
        
        console.log('Created ticket:', { 
          ticketId: ticket.id,
          user: safeUserData,
          subject: ticket.subject,
          status: ticket.status
        });
        
        responseData = {
          ...ticket,
          user: safeUserData
        };
      } else {
        console.log('Created ticket:', { 
          ticketId: ticket.id,
          subject: ticket.subject,
          status: ticket.status,
          userId: user.id
        });
        
        responseData = {
          ...ticket,
          userId: user.id
        };
      }
  
      return successResponse({ 
        ticket: responseData
      }, 201);
    } catch (error) {
      console.error('Error in ticket creation:', error instanceof Error ? error.message : 'Unknown error');
      return errorResponse(500, MESSAGES.INTERNAL_ERROR);
    }
  }

// Main request handlers
export async function GET(request: NextRequest) {
  return handleGet(request);
}

export async function POST(request: NextRequest) {
  return handlePost(request);
}
