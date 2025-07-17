import { NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@lib/prisma';
import { OrderStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

// Custom error classes for specific error types
class ValidationError extends Error {
  constructor(message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'ValidationError';
  }
}

class DatabaseError extends Error {
  constructor(message: string, public code?: string, public meta?: unknown) {
    super(message);
    this.name = 'DatabaseError';
  }
}

class NotFoundError extends Error {
  constructor(resource: string, id?: string) {
    super(`${resource}${id ? ` with ID ${id}` : ''} not found`);
    this.name = 'NotFoundError';
  }
}

// Error response helper
const errorResponse = (
  status: number, 
  message: string, 
  details: Record<string, unknown> = {},
  errorCode?: string
) => {
  const errorObject = {
    success: false,
    error: {
      status,
      code: errorCode || `ERR_${status}`,
      message,
      ...(Object.keys(details).length > 0 && { details }),
      timestamp: new Date().toISOString()
    }
  };

  console.error(`[${status}] ${message}`, JSON.stringify(errorObject, null, 2));
  
  return NextResponse.json(errorObject, {
    status,
    headers: { 
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-ID': crypto.randomUUID()
    }
  });
};

// Type definitions for Decimal handling

// Define a type that represents a Decimal-like object that can be converted to a number
type DecimalLike = {
  toNumber: () => number;
  toString: () => string;
  // Add other methods if needed
};

// Define base product variant type
type BaseProductVariant = {
  id: string;
  sku: string | null;
  barcode: string | null;
  color: string | null;
  size: string | null;
  stock: number;
  price: DecimalLike | number | string;
};

// Define base product type
type BaseProduct = {
  id: string;
  name: string;
  price: DecimalLike | number | string;
  compareAtPrice?: DecimalLike | number | string | null;
  variants: BaseProductVariant[];
};

// Define types for better type safety
type ShippingMethod = 'STANDARD' | 'EXPRESS' | 'NEXT_DAY' | 'PICKUP' | 'FREE';
type PaymentMethod = 'CREDIT_CARD' | 'DEBIT_CARD' | 'BANK_TRANSFER' | 'CASH_ON_DELIVERY' | 'WALLET';

// Export types for reuse
export type ProductVariant = BaseProductVariant;
export type Product = BaseProduct;

interface CheckoutItem {
  productId: string;
  variantId?: string;
  quantity: number;
  price: number;
}

interface ShippingAddress {
  firstName: string;
  lastName: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phoneNumber: string;
}

interface CheckoutRequest {
  userId: number;
  items: CheckoutItem[];
  shippingAddress: ShippingAddress;
  shippingMethod: ShippingMethod;
  paymentMethod: PaymentMethod;
}

// Error handler middleware - used in catch blocks
const handleError = (error: unknown) => {
  console.error('Error:', error);
  
  if (error instanceof ValidationError) {
    return errorResponse(400, error.message, error.details, 'VALIDATION_ERROR');
  }
  
  if (error instanceof DatabaseError) {
    return errorResponse(500, 'Database operation failed', {
      code: error.code,
      meta: error.meta
    }, 'DATABASE_ERROR');
  }
  
  if (error instanceof NotFoundError) {
    return errorResponse(404, error.message, {}, 'NOT_FOUND');
  }
  
  if (error instanceof z.ZodError) {
    return errorResponse(400, 'Validation failed', {
      issues: error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message,
        code: err.code
      }))
    }, 'VALIDATION_ERROR');
  }
  
  if (error instanceof Error) {
    return errorResponse(500, 'Internal server error', {
      name: error.name,
      message: error.message,
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    }, 'INTERNAL_SERVER_ERROR');
  }
  
  return errorResponse(500, 'An unknown error occurred', {}, 'UNKNOWN_ERROR');
};

// Define validation schema for checkout request
const checkoutSchema = z.object({
  userId: z.number(),
  shippingAddress: z.object({
    firstName: z.string(),
    lastName: z.string(),
    addressLine1: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
    phoneNumber: z.string()
  }),
  shippingMethod: z.enum(['STANDARD', 'EXPRESS', 'NEXT_DAY', 'PICKUP', 'FREE']),
  paymentMethod: z.enum(['CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'CASH_ON_DELIVERY', 'WALLET']),
  items: z.array(z.object({
    productId: z.string(),
    variantId: z.string().optional(),
    quantity: z.number().min(1),
    price: z.number()
  }))
})

// Helper function to calculate shipping cost based on shipping method
const calculateShippingCost = (shippingMethod: string): number => {
  const shippingCosts: Record<string, number> = {
    STANDARD: 5.99,
    EXPRESS: 9.99,
    NEXT_DAY: 14.99,
    PICKUP: 0,
    FREE: 0
  }

  return shippingCosts[shippingMethod]
}

// Generate order number helper
const generateOrderNumber = () => `ORD-${uuidv4().replace(/-/g, '').toUpperCase().substring(0, 8)}`

// POST /api/checkout - Create new order
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  
  // Helper function for consistent logging
  const log = (message: string, data?: unknown) => {
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] [${requestId}] ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`[${timestamp}] [${requestId}] ${message}`);
    }
  };
  
  const errorLog = (message: string, error: unknown) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${requestId}] ${message}`, error);
  };
  
  log('Processing checkout request');
  
  try {
    // Parse and validate request body
    let body;
    try {
      body = await request.json();
      log('Request body parsed successfully');
    } catch (e) {
      errorLog('Failed to parse request body', e);
      return handleError(new ValidationError('Invalid JSON payload', { error: e }));
    }

    // Validate against schema
    let validatedData: CheckoutRequest;
    try {
      validatedData = checkoutSchema.parse(body) as CheckoutRequest;
      log('Request validation successful');
    } catch (e) {
      if (e instanceof z.ZodError) {
        errorLog('Validation failed', e.errors);
        return handleError(new ValidationError('Invalid request data', { 
          issues: e.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
            code: err.code
          }))
        }));
      }
      errorLog('Unexpected error during validation', e);
      return handleError(e);
    }

    // Validate product and variant existence first
    log('Validating products and variants...');
    const productIds = [...new Set(validatedData.items.map(item => item.productId))];
    const variantIds = validatedData.items
      .filter((item): item is { productId: string; variantId: string; quantity: number; price: number } => !!item.variantId)
      .map(item => item.variantId);

    if (productIds.length === 0) {
      errorLog('No product IDs found in request', { items: validatedData.items });
      return errorResponse(400, 'No products in order', {}, 'NO_PRODUCTS');
    }

    // Check if all products exist
    let products: Product[] = [];

    try {
      log(`Fetching ${productIds.length} products from database`);
      const productResults = (await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { 
          variants: { 
            where: { 
              id: { in: variantIds.length > 0 ? variantIds : undefined } 
            },
            select: {
              id: true,
              sku: true,
              barcode: true,
              color: true,
              size: true,
              stock: true,
              price: true
            }
          } 
        }
      })) as unknown as Product[]; // Type assertion to handle Prisma.Decimal
      
      products = productResults;
      log(`Found ${products.length} products`);
    } catch (e) {
      errorLog('Error fetching products from database', e);
      return errorResponse(500, 'Error fetching products', {}, 'PRODUCT_FETCH_ERROR');
    }

    // Validate products existence
    const missingProducts = productIds.filter(id => !products.some(p => p.id === id));
    if (missingProducts.length > 0) {
      errorLog('Missing products', { missingProducts });
      return errorResponse(404, 'Some products not found', { missingProducts }, 'PRODUCTS_NOT_FOUND');
    }

    // Validate variants existence if provided
    const itemsWithVariants = validatedData.items.filter((item) => item.variantId);
    if (itemsWithVariants.length > 0) {
      const missingVariants: Array<{ productId: string; variantId: string }> = [];
      
      for (const item of itemsWithVariants) {
        if (!item.variantId) continue;
        
        const product = products.find(p => p.id === item.productId);
        if (product) {
          const variantExists = product.variants.some(v => v.id === item.variantId);
          if (!variantExists) {
            missingVariants.push({
              productId: item.productId,
              variantId: item.variantId
            });
          }
        }
      }
      
      if (missingVariants.length > 0) {
        errorLog('Missing variants', { missingVariants });
        return errorResponse(404, 'Some product variants not found', { missingVariants }, 'VARIANTS_NOT_FOUND');
      }
    }

    // Calculate totals
    const items = validatedData.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: Number(item.price)
    })) as Array<{ productId: string; variantId: string | null; quantity: number; price: number }>

    const subtotal = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0)
    const shippingCost = calculateShippingCost(validatedData.shippingMethod)
    const total = subtotal + shippingCost

    // Start transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx) => {
      try {
        // Create shipping address with required fields
        const shippingAddress = await tx.address.create({
          data: {
            userId: validatedData.userId,
            type: 'SHIPPING',
            firstName: validatedData.shippingAddress.firstName,
            lastName: validatedData.shippingAddress.lastName,
            addressLine1: validatedData.shippingAddress.addressLine1,
            city: validatedData.shippingAddress.city,
            state: validatedData.shippingAddress.state,
            postalCode: validatedData.shippingAddress.postalCode,
            country: validatedData.shippingAddress.country,
            phoneNumber: validatedData.shippingAddress.phoneNumber,
            isDefault: false
          }
        })

        // Generate order number
        const orderNumber = generateOrderNumber()

        // Prepare order items data
        const orderItemsData = items.map(item => {
          const product = products.find(p => p.id === item.productId)
          if (!product) {
            throw errorResponse(404, 'محصول یافت نشد', {
              productId: item.productId
            })
          }
          
          let variant = null
          if (item.variantId) {
            variant = product.variants.find(v => v.id === item.variantId)
            if (!variant) {
              throw errorResponse(404, 'نوع محصول یافت نشد', {
                variantId: item.variantId
              })
            }
          }

          // Get SKU from variant if exists, otherwise use product SKU
          const sku = variant?.sku || product.variants[0]?.sku || 'SKU-NOT-AVAILABLE'
          
          // Helper function to safely convert any numeric value to number
          const toNumber = (value: unknown): number => {
            if (value === null || value === undefined) return 0;
            if (typeof value === 'number') return value;
            if (typeof value === 'string') return Number(value) || 0;
            if (typeof value === 'object' && value !== null && 'toNumber' in value) {
              return (value as { toNumber: () => number }).toNumber();
            }
            return 0;
          };
          
          // Convert all prices to numbers
          const productPrice = toNumber(product.price);
          const variantPrice = variant ? toNumber(variant.price) : productPrice;
          const compareAtPrice = toNumber(product.compareAtPrice);
          
          return {
            productId: item.productId,
            variantId: item.variantId,
            productName: product.name,
            variantName: variant ? `${variant.color || ''} ${variant.size || ''}`.trim() || null : null,
            sku,
            barcode: variant?.barcode ? String(variant.barcode) : null,
            quantity: item.quantity,
            price: variantPrice,
            compareAtPrice,
            taxRate: 0,
            taxAmount: 0,
            discountAmount: 0,
            total: variantPrice * item.quantity,
            isReturned: false
          }
        })

        // Create order
        const order = await tx.order.create({
          data: {
            userId: validatedData.userId,
            orderNumber,
            status: OrderStatus.PENDING_PAYMENT,
            subtotal: subtotal,
            taxAmount: 0,
            shippingCost: shippingCost,
            discountAmount: 0,
            total: total,
            currency: 'Rials',
            paymentMethod: validatedData.paymentMethod,
            paymentStatus: 'PENDING',
            shippingMethod: validatedData.shippingMethod,
            shippingAddressId: shippingAddress.id,
            billingAddressId: shippingAddress.id,
            items: {
              create: orderItemsData
            },
            history: {
              create: {
                status: OrderStatus.PENDING_PAYMENT,
                comment: 'سفارش ایجاد شد',
                userId: validatedData.userId
              }
            }
          },
          include: {
            shippingAddress: true,
            items: {
              include: {
                product: true,
                variant: true
              }
            }
          }
        })

        // Update stock for variants
        const stockUpdates = orderItemsData.map(item => {
          if (!item.variantId) return null
          return tx.variant.update({
            where: { id: item.variantId },
            data: { stock: { decrement: item.quantity } }
          })
        }).filter(Boolean)

        await Promise.all(stockUpdates)

        return NextResponse.json({
          success: true,
          data: {
            order,
            paymentUrl: null // TODO: Implement payment URL generation
          }
        }, {
          status: 201,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        })
      } catch (error) {
        console.error('Error in transaction:', error)
        throw error
      }
    })

    return result
  } catch (error) {
    console.error('Error in checkout:', error)
    if (error instanceof z.ZodError) {
      return errorResponse(400, 'اطلاعات ورودی نامعتبر است', {
        errors: error.errors
      })
    }
    if (error instanceof Error) {
      return errorResponse(500, error.message, {
        details: error.stack
      })
    }
    return errorResponse(500, 'خطای سرور', {
      details: String(error)
    })
  }
}

// GET /api/checkout/:id - Get order details
export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  
  const log = (message: string, data?: unknown) => {
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] [${requestId}] ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`[${timestamp}] [${requestId}] ${message}`);
    }
  };
  
  const errorLog = (message: string, error: unknown) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${requestId}] ${message}`, error);
  };

  try {
    log('Processing GET request', {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries())
    });

    // Extract order ID from URL
    const pathname = new URL(request.url).pathname;
    const orderId = pathname.split('/').pop();

    log('Extracted order details', { pathname, orderId });

    if (!orderId) {
      return handleError(new ValidationError('شناسه سفارش اجباری است', {
        details: 'شناسه سفارش در URL وجود ندارد',
        url: request.url,
        path: pathname
      }));
    }
    
    log('Fetching order from database', { orderId });
    
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        shippingAddress: true,
        items: {
          include: {
            product: true,
            variant: true
          }
        },
        history: true
      }
    });

    log('Order fetch result', { found: !!order });

    if (!order) {
      return handleError(new NotFoundError('سفارش', orderId));
    }

    return NextResponse.json(order, {
      status: 200,
      headers: { 
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': requestId
      }
    });
  } catch (error) {
    errorLog('Error in GET handler', error);
    return handleError(error);
  }
}

// PUT /api/checkout/:id - Update order status
export async function PUT(request: Request) {
  const requestId = crypto.randomUUID();
  
  const log = (message: string, data?: unknown) => {
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] [${requestId}] ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`[${timestamp}] [${requestId}] ${message}`);
    }
  };
  
  const errorLog = (message: string, error: unknown) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${requestId}] ${message}`, error);
  };

  try {
    log('Processing PUT request', {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries())
    });
    
    // Parse request body
    let requestBody;
    try {
      requestBody = await request.json();
      log('Request body parsed successfully');
    } catch (e) {
      errorLog('Failed to parse request body', e);
      return handleError(new ValidationError('Invalid JSON payload', { error: e }));
    }

    // Extract order ID from URL
    const pathname = new URL(request.url).pathname;
    const orderId = pathname.split('/').pop();
    
    log('Extracted order details', { pathname, orderId });
    
    if (!orderId) {
      return handleError(new ValidationError('شناسه سفارش الزامی است', {
        details: 'شناسه سفارش در URL وجود ندارد',
        url: request.url,
        path: pathname
      }));
    }
    
    // Validate request body
    const { status } = requestBody as { status: OrderStatus };
    if (!status) {
      return handleError(new ValidationError('وضعیت جدید سفارش الزامی است'));
    }
    
    // Validate status is a valid OrderStatus
    const validStatuses: OrderStatus[] = Object.values(OrderStatus);
    if (!validStatuses.includes(status)) {
      return handleError(new ValidationError(
        `وضعیت نامعتبر برای سفارش: ${status}`,
        { validStatuses }
      ));
    }
    
    // Check if order exists
    log('Checking if order exists', { orderId });
    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true }
    });
    
    log('Order check result', { exists: !!existingOrder, status: existingOrder?.status });
    
    if (!existingOrder) {
      return handleError(new NotFoundError('سفارش', orderId));
    }
    
    // Update order status
    log('Updating order status', { orderId, newStatus: status });
    const updatedOrder = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id: orderId },
        data: { 
          status,
          history: {
            create: {
              status,
              comment: `وضعیت سفارش به ${status} تغییر یافت`,
              createdAt: new Date(),
              userId: 1 // TODO: Replace with actual user ID from session
            }
          }
        },
        include: {
          items: true,
          history: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });
      
      return order;
    });
    
    log('Order status updated successfully', { 
      orderId: updatedOrder.id,
      newStatus: updatedOrder.status 
    });
    
    return NextResponse.json({
      success: true, 
      message: 'وضعیت سفارش با موفقیت به‌روزرسانی شد',
      orderId: updatedOrder.id,
      status: updatedOrder.status
    }, {
      status: 200,
      headers: { 
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': requestId
      }
    });
  } catch (error) {
    errorLog('Error in PUT handler', error);
    return handleError(error);
  }

  }

// DELETE /api/checkout/:id - Cancel order
export async function DELETE(request: Request) {
  const requestId = crypto.randomUUID();
  
  const log = (message: string, data?: unknown) => {
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] [${requestId}] ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`[${timestamp}] [${requestId}] ${message}`);
    }
  };
  
  const errorLog = (message: string, error: unknown) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${requestId}] ${message}`, error);
  };

  try {
    log('Processing DELETE request', {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries())
    });

    // Extract order ID from URL
    const pathname = new URL(request.url).pathname;
    const orderId = pathname.split('/').pop();
    
    log('Extracted order details', { pathname, orderId });
    
    if (!orderId) {
      return handleError(new ValidationError('شناسه سفارش الزامی است', {
        details: 'شناسه سفارش در URL وجود ندارد',
        url: request.url,
        path: pathname
      }));
    }
    
    // Check if order exists
    log('Checking if order exists', { orderId });
    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true }
    });
    
    log('Order check result', { exists: !!existingOrder, status: existingOrder?.status });
    
    if (!existingOrder) {
      return handleError(new NotFoundError('سفارش', orderId));
    }
    
    // Check if order can be cancelled
    const validStatuses: OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.PROCESSING];
    if (!validStatuses.includes(existingOrder.status as OrderStatus)) {
      return handleError(new ValidationError(
        `سفارش در وضعیت ${existingOrder.status} قابل لغو نمی‌باشد`,
        { currentStatus: existingOrder.status, validStatuses }
      ));
    }
    
    // Update order status to CANCELLED
    log('Cancelling order', { orderId });
    const updatedOrder = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id: orderId },
        data: { 
          status: OrderStatus.CANCELLED,
          history: {
            create: {
              status: OrderStatus.CANCELLED,
              comment: 'سفارش توسط کاربر لغو شد',
              userId: 1, // TODO: Replace with actual user ID from session
              createdAt: new Date()
            }
          }
        },
        include: {
          items: true,
          history: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });
      
      return order;
    });
    
    log('Order cancelled successfully', { 
      orderId: updatedOrder.id,
      newStatus: updatedOrder.status 
    });
    
    return NextResponse.json({
      success: true, 
      message: 'سفارش با موفقیت لغو شد',
      orderId: updatedOrder.id,
      status: updatedOrder.status
    }, {
      status: 200,
      headers: { 
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': requestId
      }
    });
  } catch (error) {
    errorLog('Error in DELETE handler', error);
    return handleError(error);
  }
}