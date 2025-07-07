import { NextResponse, NextRequest } from 'next/server';
import { 
  PrismaClient, 
  OrderStatus, 
  PaymentStatus, 
  PaymentMethod,
  ShippingMethod,
  Prisma 
} from '@prisma/client';
import { authenticateRequest } from '../../../../../lib/api-utils';
import { rateLimitMiddleware } from '../../../../../lib/rate-limiter';
import { z } from 'zod';

// Error messages in Farsi
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  FORBIDDEN: 'شما مجوز دسترسی به این منبع را ندارید.',
  NOT_FOUND: 'سفارش یافت نشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.',
  INVALID_ORDER_STATUS: 'وضعیت سفارش نامعتبر است.',
  UPDATE_FAILED: 'به‌روزرسانی سفارش با خطا مواجه شد.'
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

const prisma = new PrismaClient();

// Zod schemas for validation
const orderUpdateSchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  paymentStatus: z.nativeEnum(PaymentStatus).optional(),
  trackingCode: z.string().optional(),
  shippingStatus: z.string().optional(),
  notes: z.string().optional()
}).refine(
  data => Object.keys(data).length > 0,
  { message: 'حداقل یک فیلد برای به‌روزرسانی الزامی است' }
);

// Helper to get user from token
async function getAuthenticatedUser(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success || !auth.adminId) return null;
  
  return await prisma.admin.findUnique({
    where: { id: auth.adminId },
    select: { id: true, role: true, email: true }
  });
}

// Helper to check order ownership/access
async function canAccessOrder(orderId: string, userId: number, userRole: string) {
  // Admins can access any order
  if (['OWNER', 'MANAGER', 'OPERATOR'].includes(userRole)) {
    return true;
  }
  
  // Regular users can only access their own orders
  const order = await prisma.order.findUnique({
    where: { id: orderId, userId }
  });
  
  return !!order;
}

// GET /api/orders/[id] - Get order by ID
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  // Apply rate limiting
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    `orders:detail:${params.id}`,
    'user' // Use 'user' rate limit for order details
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    const orderId = params.id;
    
    // Check access
    const hasAccess = await canAccessOrder(orderId, user.id, user.role);
    if (!hasAccess) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }
    
    // Get order with related data
    const order = await prisma.order.findUnique({
      where: { id: orderId },
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
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                slug: true,
                mainImage: true
              }
            },
            variant: {
              select: {
                id: true,
                size: true,
                color: true,
                colorHex: true
              }
            }
          }
        },
        shippingAddress: true,
        billingAddress: true,
        history: {
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
              }
            }
          }
        },
        notes: {
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
              }
            }
          }
        }
      }
    });
    
    if (!order) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }
    
    return successResponse({ order });
    
  } catch (error: unknown) {
    console.error('Error fetching order:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}

// PATCH /api/orders/[id] - Update order
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  // Apply rate limiting
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    `orders:update:${params.id}`,
    'sensitive' // Use 'sensitive' rate limit for updates
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    // Only admins can update orders
    if (!['OWNER', 'MANAGER', 'OPERATOR'].includes(user.role)) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }
    
    const orderId = params.id;
    
    // Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch (error: unknown) {
      console.error('Error parsing request body:', error);
      return errorResponse(400, 'بدنه درخواست نامعتبر است');
    }
    
    const validation = orderUpdateSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        errors: validation.error.flatten()
      });
    }
    
    const { status, paymentStatus, trackingCode, shippingStatus, notes } = validation.data;
    
    // Start a transaction
    return await prisma.$transaction(async (tx) => {
      // Get the current order
      const currentOrder = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true, paymentStatus: true }
      });
      
      if (!currentOrder) {
        return errorResponse(404, MESSAGES.NOT_FOUND);
      }
      
      // Prepare update data with proper typing
      const updateData: {
        status?: OrderStatus;
        paymentStatus?: PaymentStatus;
        trackingCode?: string;
        shippingStatus?: string;
        updatedAt: Date;
      } = {
        updatedAt: new Date()
      };
      
      // Handle status update
      if (status && status !== currentOrder.status) {
        updateData.status = status;
        await tx.orderHistory.create({
          data: {
            orderId,
            status: 'PENDING_PAYMENT',
            comment: `Order status changed to ${status}`,
            userId: user.id,
            createdAt: new Date()
          }
        });
      }
      
      // Handle payment status update
      if (paymentStatus && paymentStatus !== currentOrder.paymentStatus) {
        updateData.paymentStatus = paymentStatus;
        await tx.orderHistory.create({
          data: {
            orderId,
            status: 'PAYMENT_RECEIVED',
            comment: `Payment status updated to ${paymentStatus}`,
            userId: user.id,
            createdAt: new Date()
          }
        });
      }
      
      // Handle tracking code update
      if (trackingCode) {
        updateData.trackingCode = trackingCode;
        await tx.orderHistory.create({
          data: {
            orderId,
            status: 'SHIPPED',
            comment: `Tracking code updated to ${trackingCode}`,
            userId: user.id,
            createdAt: new Date()
          }
        });
      }
      
      // Handle shipping status update
      if (shippingStatus) {
        updateData.shippingStatus = shippingStatus;
        await tx.orderHistory.create({
          data: {
            orderId,
            status: 'OUT_FOR_DELIVERY',
            comment: `Shipping status updated to ${shippingStatus}`,
            userId: user.id,
            createdAt: new Date()
          }
        });
      }
      
      // Add note if provided
      if (notes) {
        await tx.orderHistory.create({
          data: {
            orderId,
            status: 'ON_HOLD',
            comment: notes,
            userId: user.id,
            createdAt: new Date()
          }
        });
      }
      
      // Update the order
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: updateData,
        include: {
          items: true,
          shippingAddress: true,
          billingAddress: true
        }
      });
      
      // TODO: Trigger notifications based on status changes
      
      return successResponse({
        order: updatedOrder,
        message: 'سفارش با موفقیت به‌روزرسانی شد.'
      });
      
    }); // End of transaction
    
  } catch (error) {
    console.error('Error updating order:', error);
    
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') { // Record not found
        return errorResponse(404, MESSAGES.NOT_FOUND);
      }
    }
    
    return errorResponse(500, MESSAGES.INTERNAL_ERROR, { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}

// Define types for the request body
interface OrderItemInput {
  productId: string;
  variantId?: string | null;
  sku?: string; // Add sku to the interface
  quantity: number;
  price: number;
  compareAtPrice?: number | null;
  taxRate?: number;
  taxAmount?: number;
  discountAmount?: number;
}

interface UpdateOrderInput {
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  shippingAddress?: string | null;
  billingAddress?: string | null;
  status?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  shippingMethod?: string;
  notes?: string | null;
  items: OrderItemInput[];
}

// PUT /api/orders/[id] - Replace an order (complete update)
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  // Apply rate limiting
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    `orders:replace:${params.id}`,
    'sensitive' // Use 'sensitive' rate limit for complete updates
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    // Authenticate user
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }

    // Only admins can update orders
    if (!['OWNER', 'MANAGER', 'OPERATOR'].includes(user.role)) {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }

    // Parse and validate request body
    let body: UpdateOrderInput;
    try {
      body = await request.json();
    } catch (error) {
      console.error('Error parsing request body:', error);
      return errorResponse(400, MESSAGES.INVALID_INPUT, { error: 'Invalid JSON' });
    }

    // Validate required fields for complete order replacement
    const requiredFields = ['customerName', 'customerPhone', 'items'];
    const missingFields = requiredFields.filter(field => !(field in body));
    
    if (missingFields.length > 0) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        error: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields
      });
    }

    // Validate items array
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        error: 'Order must contain at least one item'
      });
    }

    const orderId = params.id;
    
    // Check if order exists
    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true }
    });

    if (!existingOrder) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }

    // Start transaction for atomic update
    const updatedOrder = await prisma.$transaction(async (tx) => {
      // Delete existing order items
      await tx.orderItem.deleteMany({
        where: { orderId: orderId }
      });

      // Calculate total amount
      const totalAmount = body.items.reduce((sum, item) => {
        return sum + (item.price * item.quantity);
      }, 0);

      // Create a note if provided
      if (body.notes) {
        await tx.orderNote.create({
          data: {
            content: body.notes,
            orderId: orderId,
            userId: user.id,
            isPublic: true
          }
        });
      }

      // Update the order with proper type casting for enums
      const order = await tx.order.update({
        where: { id: orderId },
        data: {
          user: {
            connect: { id: user.id }
          },
          status: (body.status as OrderStatus) || 'PENDING',
          paymentStatus: (body.paymentStatus as PaymentStatus) || 'PENDING',
          paymentMethod: (body.paymentMethod as PaymentMethod) || 'CASH',
          shippingMethod: (body.shippingMethod as ShippingMethod) || 'STANDARD',
          subtotal: totalAmount,
          taxAmount: body.items.reduce((sum, item) => sum + (item.taxAmount || 0), 0),
          discountAmount: body.items.reduce((sum, item) => sum + (item.discountAmount || 0), 0),
          total: totalAmount,
          updatedAt: new Date(),
          // Create new order items with required fields
          items: {
            create: await Promise.all(body.items.map(async (item) => {
              // Fetch product details to get the name
              const product = await tx.product.findUnique({
                where: { id: item.productId },
                select: { 
                  name: true
                }
              });

              // Get variant details if variantId is provided
              let variantSku = item.sku || 'N/A';
              if (item.variantId) {
                const variant = await tx.variant.findUnique({
                  where: { id: item.variantId },
                  select: { 
                    sku: true
                  }
                });
                if (variant?.sku) {
                  variantSku = variant.sku;
                }
              }

              const productName = product?.name || 'Unknown Product';

              return {
                product: { connect: { id: item.productId } },
                productName: productName,
                sku: variantSku,
                ...(item.variantId && { 
                  variant: { connect: { id: item.variantId } }
                }),
                quantity: item.quantity,
                price: item.price,
                compareAtPrice: item.compareAtPrice || null,
                taxRate: item.taxRate || 0,
                taxAmount: item.taxAmount || 0,
                discountAmount: item.discountAmount || 0,
                total: (item.price * item.quantity) - (item.discountAmount || 0)
              };
            }))
          }
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  variants: {
                    select: {
                      id: true,
                      sku: true
                    }
                  }
                }
              }
            }
          },
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true
            }
          },
          notes: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { content: true }
          }
        }
      });

      return order;
    });

    return successResponse({ order: updatedOrder });
  } catch (error) {
    console.error('Error updating order:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR, {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// DELETE /api/orders/[id] - Delete an order
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  // Apply rate limiting
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    `orders:delete:${params.id}`,
    'sensitive' // Use 'sensitive' rate limit for deletes
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    // Authenticate user
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }

    // Only admins can delete orders
    if (user.role !== 'OWNER' && user.role !== 'MANAGER') {
      return errorResponse(403, MESSAGES.FORBIDDEN);
    }

    // Find the order
    const order = await prisma.order.findUnique({
      where: { id: params.id },
      include: { items: true }
    });

    if (!order) {
      return errorResponse(404, MESSAGES.NOT_FOUND);
    }

    // Use a transaction to ensure data consistency
    await prisma.$transaction([
      // First, delete all related order items
      prisma.orderItem.deleteMany({
        where: { orderId: params.id }
      }),
      // Then delete the order
      prisma.order.delete({
        where: { id: params.id }
      })
    ]);

    return successResponse({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Error deleting order:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR);
  }
}
