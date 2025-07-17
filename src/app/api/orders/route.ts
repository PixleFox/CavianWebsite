import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient, OrderStatus, PaymentStatus, PaymentMethod, ShippingMethod } from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

import { authenticateRequest } from '../../../../lib/api-utils';
import { rateLimitMiddleware } from '../../../../lib/rate-limiter';
import { z } from 'zod';

// Helper function to safely convert Decimal to number
function toNumber(value: number | string | Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloat(value) || 0;
  return value.toNumber ? value.toNumber() : 0;
}

// Error messages in Farsi
const MESSAGES = {
  UNAUTHORIZED: 'دسترسی غیر مجاز. لطفا وارد شوید.',
  INVALID_TOKEN: 'توکن نامعتبر است.',
  FORBIDDEN: 'شما مجوز دسترسی به این منبع را ندارید.',
  NOT_FOUND: 'سفارش یافت نشد.',
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.',
  PRODUCT_NOT_FOUND: 'محصول یافت نشد.',
  INSUFFICIENT_STOCK: 'موجودی کافی نیست.',
  INVALID_ORDER_STATUS: 'وضعیت سفارش نامعتبر است.',
  PAYMENT_REQUIRED: 'پرداخت تایید نشده است.'
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
const orderItemSchema = z.object({
    productId: z.string().min(1, 'شناسه محصول نامعتبر است'),
    variantId: z.string().min(1, 'شناسه نوع محصول نامعتبر است').optional(),
    quantity: z.number().int().positive('تعداد باید بیشتر از صفر باشد'),
  });
  
const shippingAddressSchema = z.object({
  firstName: z.string().min(1, 'نام الزامی است'),
  lastName: z.string().min(1, 'نام خانوادگی الزامی است'),
  addressLine1: z.string().min(1, 'آدرس الزامی است'),
  addressLine2: z.string().optional(),
  city: z.string().min(1, 'شهر الزامی است'),
  state: z.string().optional(),
  postalCode: z.string().min(1, 'کد پستی الزامی است'),
  country: z.string().min(1, 'کشور الزامی است'),
  phoneNumber: z.string().min(1, 'شماره تماس الزامی است'),
});

const orderCreateSchema = z.object({
  items: z.array(orderItemSchema).min(1, 'حداقل یک آیتم سفارش الزامی است'),
  shippingAddress: shippingAddressSchema,
  billingAddress: shippingAddressSchema.optional(),
  customerNotes: z.string().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod, {
    errorMap: () => ({ message: 'روش پرداخت نامعتبر است' })
  }),
  shippingMethod: z.nativeEnum(ShippingMethod, {
    errorMap: () => ({ message: 'روش ارسال نامعتبر است' })
  }),
  useShippingAsBilling: z.boolean().default(true),
});

// Helper to get user from token
async function getAuthenticatedUser(request: Request) {
  const auth = await authenticateRequest(request);
  
  // If authentication failed, return null
  if (!auth.success) return null;
  
  // If admin, return admin info
  if (auth.adminId) {
    return {
      id: auth.adminId,
      role: auth.role || 'ADMIN',
      type: 'admin'
    };
  }

  // If user, return user info
  if (auth.userId) {
    return {
      id: auth.userId,
      role: auth.role || 'USER',
      type: 'user'
    };
  }

  return null;
}

// Handler for GET /api/orders - List orders with filters
async function handleGet(request: Request) {
  // Apply rate limiting for authenticated users
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    'orders:list',
    'user' // Use 'user' rate limit for authenticated users
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }

    const { searchParams } = new URL(request.url);
    
    // Build where clause
    const where: {
      status?: OrderStatus;
      paymentStatus?: PaymentStatus;
      userId?: number;
      createdAt?: { gte?: Date; lte?: Date };
    } = {};
    
    // Filter by status
    const status = searchParams.get('status') as OrderStatus | null;
    if (status && Object.values(OrderStatus).includes(status)) {
      where.status = status;
    }
    
    // Filter by payment status
    const paymentStatus = searchParams.get('paymentStatus') as PaymentStatus | null;
    if (paymentStatus && Object.values(PaymentStatus).includes(paymentStatus)) {
      where.paymentStatus = paymentStatus;
    }
    
    // Filter by user ID (for admins viewing user orders)
    const userId = searchParams.get('userId');
    if (userId) {
      // Only allow admins to filter by any user ID
      if (user.role !== 'ADMIN') {
        return errorResponse(403, MESSAGES.FORBIDDEN);
      }
      where.userId = parseInt(userId);
    } else {
      // Regular users can only see their own orders
      where.userId = user.id;
    }
    
    // Date range filter
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    // Pagination
    const page = parseInt(searchParams.get('page') || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 100);
    const skip = (page - 1) * limit;
    
    // Get orders with pagination
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
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
                  mainImage: true
                }
              },
              variant: {
                select: {
                  id: true,
                  size: true,
                  color: true
                }
              }
            }
          },
          shippingAddress: true,
          billingAddress: true
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.order.count({ where })
    ]);
    
    return successResponse({
      data: orders,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching orders:', error);
    return errorResponse(500, MESSAGES.INTERNAL_ERROR, { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

// Handler for POST /api/orders - Create a new order
async function handlePost(request: Request) {
  // Apply rate limiting for order creation
  const rateLimit = await rateLimitMiddleware(
    request as NextRequest,
    'orders:create',
    'sensitive' // Use 'sensitive' rate limit for order creation
  );
  
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return errorResponse(401, MESSAGES.UNAUTHORIZED);
    }
    
    // Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'بدنه درخواست نامعتبر است');
    }
    
    const validation = orderCreateSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(400, MESSAGES.INVALID_INPUT, {
        errors: validation.error.flatten()
      });
    }
    
    const { items, shippingAddress, billingAddress, useShippingAsBilling } = validation.data;
    
    // Start a transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx) => {
      try {
        // 1. Verify all products and variants exist and have sufficient stock
        const productIds = [...new Set(items.map(item => item.productId))];
        const variantIds = items.map(item => item.variantId).filter(Boolean) as string[];
        
        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
          include: { 
            variants: { 
              where: { id: { in: variantIds } },
              include: { product: true }
            } 
          }
        });
        
        // Check if all products exist
        const missingProductIds = productIds.filter(id => !products.some(p => p.id === id));
        if (missingProductIds.length > 0) {
          throw errorResponse(404, 'برخی از محصولات یافت نشدند', {
            missingProductIds
          });
        }
        
        // Check if all variants exist and have sufficient stock
        const stockIssues: Array<{
          productId: string;
          variantId?: string;
          available: number;
          requested: number;
        }> = [];
        
        // Type for enriched order items
        type EnrichedItem = {
          product: {
            id: string;
            name: string;
            sku: string;
            price: number | null;
            compareAtPrice: number | null;
          };
          variant: {
            id: string;
            sku: string;
            price: number | null;
            compareAtPrice: number | null;
            stock: number;
            [key: string]: unknown;
          } | null;
          quantity: number;
          price: number;
          compareAtPrice: number | null;
          taxRate: number;
          taxAmount: number;
          discountAmount: number;
          total: number;
        };
        
        // Initialize enriched items array
        const enrichedItems: EnrichedItem[] = [];
        
        for (const item of items) {
          const product = products.find(p => p.id === item.productId);
          if (!product) continue;
          
          // For variant products
          if (item.variantId) {
            const variant = product.variants.find(v => v.id === item.variantId);
            if (!variant) {
              throw errorResponse(400, MESSAGES.INVALID_INPUT, { error: `Variant not found: ${item.variantId}` });
            }
            
            // Convert Decimal to number for calculations
            const variantPrice = variant.price ? toNumber(variant.price) : toNumber(product.price);
            
            // Get compareAtPrice from product since Variant doesn't have it
            const variantCompareAtPrice = product.compareAtPrice ? 
              toNumber(product.compareAtPrice) : 
              null;
            
            // Check stock
            if (variant.stock < item.quantity) {
              stockIssues.push({
                productId: product.id,
                variantId: variant.id,
                available: variant.stock,
                requested: item.quantity
              });
            }
            
            // Create a product data object with the required properties
            const productPrice = product.price ? toNumber(product.price) : 0;
            const productCompareAtPrice = product.compareAtPrice ? toNumber(product.compareAtPrice) : null;
            // Use a type assertion to safely access the sku property
            const productSku = (product as { sku?: string }).sku || '';
            
            enrichedItems.push({
              product: {
                id: product.id,
                name: product.name,
                sku: productSku,
                price: productPrice,
                compareAtPrice: productCompareAtPrice
              },
              variant: {
                ...variant,
                price: variantPrice,
                compareAtPrice: variantCompareAtPrice
              },
              quantity: item.quantity,
              price: variantPrice,
              compareAtPrice: variantCompareAtPrice,
              taxRate: 0, // TODO: Calculate tax
              taxAmount: 0,
              discountAmount: 0,
              total: variantPrice * item.quantity
            });
          } else {
            // Handle products without variants
            if (product.totalStock < item.quantity) {
              stockIssues.push({
                productId: product.id,
                available: product.totalStock,
                requested: item.quantity
              });
            }
            
            // Convert Decimal to number for calculations
            const productPrice = toNumber(product.price);
            const productCompareAtPrice = product.compareAtPrice ? toNumber(product.compareAtPrice) : null;
            
            enrichedItems.push({
              product: {
                id: product.id,
                name: product.name,
                sku: (product as { sku?: string }).sku || '',
                price: productPrice,
                compareAtPrice: productCompareAtPrice
              },
              variant: null,
              quantity: item.quantity,
              price: productPrice,
              compareAtPrice: productCompareAtPrice,
              taxRate: 0, // TODO: Calculate tax
              taxAmount: 0,
              discountAmount: 0,
              total: productPrice * item.quantity
            });
          }
        }
        
        if (stockIssues.length > 0) {
          throw errorResponse(400, MESSAGES.INSUFFICIENT_STOCK, { stockIssues });
        }
        
        // Calculate order totals
        const subtotal = enrichedItems.reduce((sum, item) => {
          const price = toNumber(item.price);
          return sum + (price * item.quantity);
        }, 0);
        const taxAmount = enrichedItems.reduce((sum, item) => sum + item.taxAmount, 0);
        const shippingCost = 0; // TODO: Calculate shipping cost based on method and address
        const discountAmount = 0; // TODO: Apply discounts
        const total = subtotal + taxAmount + shippingCost - discountAmount;
        
        // Create shipping address with required fields
        const shippingAddr = await tx.address.create({
          data: {
            ...shippingAddress,
            phoneNumber: shippingAddress.phoneNumber || '',
            userId: user.id,
            type: 'SHIPPING'
          }
        });
        
        // Create billing address with required fields
        const billingAddr = await tx.address.create({
          data: useShippingAsBilling 
            ? { 
                ...shippingAddress,
                phoneNumber: shippingAddress.phoneNumber || '',
                userId: user.id,
                type: 'BILLING'
              }
            : { 
                ...billingAddress!,
                phoneNumber: billingAddress!.phoneNumber || '',
                userId: user.id,
                type: 'BILLING'
              }
        });

        // Prepare order items data
        const orderItemsData = enrichedItems.map(item => {
          const price = toNumber(item.price);
          const total = price * item.quantity;
          const variantName = item.variant 
            ? `${item.variant.color || ''} ${item.variant.size || ''}`.trim() || null
            : null;
          
          return {
            productId: item.product.id,
            variantId: item.variant?.id,
            userId: user.id,
            productName: item.product.name,
            variantName: variantName,
            sku: item.variant?.sku || 'SKU-NOT-AVAILABLE',
            barcode: item.variant?.barcode ? String(item.variant.barcode) : null,
            quantity: item.quantity,
            price: price,
            compareAtPrice: item.compareAtPrice !== null && item.compareAtPrice !== undefined 
              ? toNumber(item.compareAtPrice) 
              : null,
            taxRate: item.taxRate,
            taxAmount: item.taxAmount,
            discountAmount: item.discountAmount,
            total: total
          };
        });

        // Create the order
        const order = await tx.order.create({
          data: {
            orderNumber: `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            userId: user.id,
            status: OrderStatus.PENDING_PAYMENT,
            subtotal,
            taxAmount,
            shippingCost: 0,
            discountAmount: 0,
            total,
            paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
            paymentStatus: PaymentStatus.PENDING,
            shippingMethod: ShippingMethod.STANDARD,
            shippingAddressId: shippingAddr.id,
            billingAddressId: billingAddr.id,
            items: {
              create: orderItemsData.map(item => ({
                productId: item.productId,
                variantId: item.variantId,
                userId: user.id,
                productName: item.productName,
                variantName: item.variantName,
                sku: item.sku,
                barcode: item.barcode,
                quantity: item.quantity,
                price: item.price,
                compareAtPrice: item.compareAtPrice,
                taxRate: item.taxRate,
                taxAmount: item.taxAmount,
                discountAmount: item.discountAmount,
                total: item.total,
                isReturned: false
              }))
            },
            history: {
              create: [{
                userId: user.id,
                status: OrderStatus.PENDING_PAYMENT,
                comment: 'سفارش ایجاد شد.'
              }]
            }
          },
          include: {
            items: true,
            shippingAddress: true,
            billingAddress: true
          }
        });

        // Update product stock
        for (const item of enrichedItems) {
          if (item.variant) {
            await tx.variant.update({
              where: { id: item.variant.id },
              data: { stock: { decrement: item.quantity } }
            });
          } else {
            await tx.product.update({
              where: { id: item.product.id },
              data: { totalStock: { decrement: item.quantity } }
            });
          }
        }

        // Return success response
        return successResponse({
          order,
          paymentUrl: null // TODO: Return payment URL if needed
        }, 201);
      } catch (error) {
        console.error('Error in transaction:', error);
        throw error;
      }
    })

    return NextResponse.json({
      success: true,
      data: {
        order: result,
        paymentUrl: null // TODO: Return payment URL if needed
      }
    }, { 
      status: 201,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (error) {
    console.error('Error in order creation:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور' },
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }
    );
  }
}

// Main request handler
export async function GET(request: Request) {
  try {
    return await handleGet(request);
  } catch (error) {
    console.error('Error in orders GET handler:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (error) {
    console.error('Error in orders POST handler:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور' },
      { status: 500 }
    );
  }
}
