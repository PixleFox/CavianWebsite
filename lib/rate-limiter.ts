import { NextRequest } from 'next/server';

type CompatibleRequest = NextRequest | Request;
import { authenticateRequest } from './api-utils';

// In-memory store for rate limiting
interface RateLimitEntry {
  count: number;
  lastRequest: number;
  resetTime: number;
}

type RateLimitKey = `${string}:${string}`; // Format: 'ip:endpoint' or 'userId:endpoint'
const rateLimitStore = new Map<RateLimitKey, RateLimitEntry>();

// Rate limit configurations
interface RateLimitConfig {
  windowMs: number;
  max: number;
}

interface RateLimitConfigs {
  public: RateLimitConfig;
  user: RateLimitConfig;
  admin: RateLimitConfig;
  sensitive: RateLimitConfig;
  product: {
    list: RateLimitConfig;
    detail: RateLimitConfig;
    create: RateLimitConfig;
    update: RateLimitConfig;
    delete: RateLimitConfig;
  };
  ticket: {
    list: RateLimitConfig;
    detail: RateLimitConfig;
    create: RateLimitConfig;
    update: RateLimitConfig;
    delete: RateLimitConfig;
    message: {
      list: RateLimitConfig;
      create: RateLimitConfig;
    };
  };
}

const RATE_LIMIT_CONFIG: RateLimitConfigs = {
  // Public endpoints (no auth required)
  public: {
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute per IP
  },
  // Authenticated users
  user: {
    windowMs: 60 * 1000, // 1 minute
    max: 120, // 120 requests per minute per user
  },
  // Admin endpoints
  admin: {
    windowMs: 60 * 1000, // 1 minute
    max: 300, // 300 requests per minute per admin
  },
  // Sensitive endpoints (login, password reset, etc.)
  sensitive: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // 15 requests per 15 minutes per IP
  },
  // Product endpoints
  product: {
    list: {
      windowMs: 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute per IP/user
    },
    detail: {
      windowMs: 60 * 1000, // 1 minute
      max: 200, // 200 requests per minute per IP/user
    },
    create: {
      windowMs: 60 * 1000, // 1 minute
      max: 30, // 30 requests per minute per user
    },
    update: {
      windowMs: 60 * 1000, // 1 minute
      max: 60, // 60 requests per minute per user
    },
    delete: {
      windowMs: 60 * 1000, // 1 minute
      max: 30, // 30 requests per minute per user
    },
  },
  // Ticket endpoints
  ticket: {
    list: {
      windowMs: 60 * 1000, // 1 minute
      max: 60, // 60 requests per minute per user
    },
    detail: {
      windowMs: 60 * 1000, // 1 minute
      max: 120, // 120 requests per minute per user
    },
    create: {
      windowMs: 60 * 1000, // 1 minute
      max: 10, // 10 ticket creations per minute per user
    },
    update: {
      windowMs: 60 * 1000, // 1 minute
      max: 30, // 30 updates per minute per user
    },
    delete: {
      windowMs: 60 * 1000, // 1 minute
      max: 10, // 10 deletes per minute per user
    },
    message: {
      list: {
        windowMs: 60 * 1000, // 1 minute
        max: 100, // 100 list requests per minute per user
      },
      create: {
        windowMs: 60 * 1000, // 1 minute
        max: 20, // 20 messages per minute per user
      },
    },
  },
} as const;

/**
 * Get the client's IP address from the request
 */
function getClientIp(request: NextRequest): string {
  // Try to get the real IP if behind a proxy
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  
  // Try to get IP from headers
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return cfConnectingIp;
  }
  
  // Fallback
  return 'unknown-ip';
}

/**
 * Generate a rate limit key
 */
function generateKey(identifier: string, endpoint: string): RateLimitKey {
  return `${identifier}:${endpoint}` as const;
}

/**
 * Check if the request has exceeded the rate limit
 */
export async function isRateLimited(
  request: CompatibleRequest,
  endpoint: string,
  type: keyof typeof RATE_LIMIT_CONFIG | 'product' | 'ticket' = 'public',
  subType?: keyof RateLimitConfigs['product'] | keyof RateLimitConfigs['ticket'],
  subSubType?: keyof RateLimitConfigs['ticket']['message']
): Promise<{ isLimited: boolean; retryAfter?: number; limit?: number; remaining?: number; resetTime?: number }> {
  // Get the appropriate rate limit config
  let config: RateLimitConfig;
  
  if (type === 'product' && subType) {
    // For product-specific rate limits
    config = RATE_LIMIT_CONFIG.product[subType as keyof RateLimitConfigs['product']];
  } else if (type === 'ticket' && subType) {
    // For ticket message rate limits
    if (subType === 'message' && subSubType) {
      config = RATE_LIMIT_CONFIG.ticket.message[subSubType];
    } else if (subType !== 'message') {
      // For standard ticket rate limits
      config = RATE_LIMIT_CONFIG.ticket[subType as keyof Omit<RateLimitConfigs['ticket'], 'message'>];
    } else {
      // Default to public rate limit if type is not recognized
      config = RATE_LIMIT_CONFIG.public;
    }
  } else if (type !== 'ticket' && type !== 'product') {
    // For standard rate limits
    config = RATE_LIMIT_CONFIG[type as keyof Omit<RateLimitConfigs, 'product' | 'ticket'>];
  } else {
    // Default to public rate limit if type is not recognized
    config = RATE_LIMIT_CONFIG.public;
  }
  const now = Date.now();
  
  // Try to get user ID from session if available
  let identifier = 'unknown-ip';
  
  // Only try to get IP if it's a NextRequest
  if ('headers' in request) {
    identifier = getClientIp(request as NextRequest);
  }
  
  try {
    const auth = await authenticateRequest(request);
    if (auth.success && auth.userId) {
      // Use user ID as identifier for authenticated users
      identifier = `user-${auth.userId}`;
    }
  } catch (error) {
    // Ignore auth errors and fall back to IP
    console.error('Error authenticating request:', error);
  }

  const key = generateKey(identifier, endpoint);
  const entry = rateLimitStore.get(key);
  const resetTime = entry?.resetTime || now + config.windowMs;
  
  // Initialize or update the rate limit entry
  if (!entry) {
    rateLimitStore.set(key, {
      count: 1,
      lastRequest: now,
      resetTime,
    });
    return { 
      isLimited: false,
      limit: config.max,
      remaining: config.max - 1,
      resetTime
    };
  }

  // Reset the counter if the window has passed
  if (now > entry.resetTime) {
    entry.count = 1;
    entry.resetTime = now + config.windowMs;
    entry.lastRequest = now;
    return { 
      isLimited: false,
      limit: config.max,
      remaining: config.max - 1,
      resetTime: entry.resetTime
    };
  }

  // Check if rate limit is exceeded
  if (entry.count >= config.max) {
    return { 
      isLimited: true, 
      retryAfter: Math.ceil((entry.resetTime - now) / 1000), // in seconds
      limit: config.max,
      remaining: 0,
      resetTime: entry.resetTime
    };
  }

  // Increment the counter
  entry.count++;
  entry.lastRequest = now;
  
  return { 
    isLimited: false,
    limit: config.max,
    remaining: Math.max(0, config.max - entry.count),
    resetTime: entry.resetTime
  };
}

/**
 * Rate limit middleware for API routes
 */
export async function rateLimitMiddleware(
  request: CompatibleRequest,
  endpoint: string,
  type: keyof Omit<RateLimitConfigs, 'product' | 'ticket'> | 'product' | 'ticket' = 'public',
  subType?: keyof RateLimitConfigs['product'] | keyof Omit<RateLimitConfigs['ticket'], 'message'>,
  subSubType?: keyof RateLimitConfigs['ticket']['message']
) {
  const rateLimit = await isRateLimited(request, endpoint, type, subType, subSubType);
  
  if (rateLimit.isLimited) {
    const response = new Response(
      JSON.stringify({
        success: false,
        error: 'Too many requests',
        message: 'شما درخواست‌های زیادی ارسال کرده‌اید. لطفاً بعداً دوباره تلاش کنید.',
        retryAfter: rateLimit.retryAfter,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': rateLimit.retryAfter?.toString() || '60',
          'X-RateLimit-Limit': rateLimit.limit?.toString() || '0',
          'X-RateLimit-Remaining': rateLimit.remaining?.toString() || '0',
          'X-RateLimit-Reset': rateLimit.resetTime?.toString() || '0',
        },
      }
    );
    
    return { response, isRateLimited: true };
  }
  
  return { 
    response: new Response(null, { status: 200 }),
    isRateLimited: false,
    headers: {
      'X-RateLimit-Limit': rateLimit.limit?.toString() || '0',
      'X-RateLimit-Remaining': rateLimit.remaining?.toString() || '0',
      'X-RateLimit-Reset': rateLimit.resetTime?.toString() || '0',
    }
  };
}

// Helper functions for product-specific rate limiting
export const productRateLimiter = {
  // List products
  list: async (request: NextRequest, productId?: string) => 
    rateLimitMiddleware(request, `products:list${productId ? `:${productId}` : ''}`, 'product', 'list'),
  
  // Get product details
  detail: async (request: NextRequest, productId: string) => 
    rateLimitMiddleware(request, `products:detail:${productId}`, 'product', 'detail'),
    
  // Create product
  create: async (request: NextRequest) => 
    rateLimitMiddleware(request, 'products:create', 'product', 'create'),
    
  // Update product
  update: async (request: NextRequest, productId: string) => 
    rateLimitMiddleware(request, `products:update:${productId}`, 'product', 'update'),
    
  // Delete product
  delete: async (request: NextRequest, productId: string) => 
    rateLimitMiddleware(request, `products:delete:${productId}`, 'product', 'delete'),
    
  // List product variants
  listVariants: async (request: NextRequest, productId: string) =>
    rateLimitMiddleware(request, `products:${productId}:variants:list`, 'product', 'list'),
    
  // Create product variant
  createVariant: async (request: NextRequest, productId: string) =>
    rateLimitMiddleware(request, `products:${productId}:variants:create`, 'product', 'create'),
    
  // Update product variant
  updateVariant: async (request: NextRequest, productId: string, variantId: string) =>
    rateLimitMiddleware(request, `products:${productId}:variants:update:${variantId}`, 'product', 'update'),
    
  // Delete product variant
  deleteVariant: async (request: NextRequest, productId: string, variantId: string) =>
    rateLimitMiddleware(request, `products:${productId}:variants:delete:${variantId}`, 'product', 'delete')
};

// Helper functions for ticket-specific rate limiting
export const ticketRateLimiter = {
  // List tickets
  list: async (request: NextRequest) => 
    rateLimitMiddleware(request, 'tickets:list', 'ticket', 'list'),
  
  // Get ticket details
  detail: async (request: NextRequest, ticketId: string) => 
    rateLimitMiddleware(request, `tickets:detail:${ticketId}`, 'ticket', 'detail'),
    
  // Create ticket
  create: async (request: NextRequest) => 
    rateLimitMiddleware(request, 'tickets:create', 'ticket', 'create'),
    
  // Update ticket
  update: async (request: NextRequest, ticketId: string) => 
    rateLimitMiddleware(request, `tickets:update:${ticketId}`, 'ticket', 'update'),
    
  // Delete ticket
  delete: async (request: NextRequest, ticketId: string) => 
    rateLimitMiddleware(request, `tickets:delete:${ticketId}`, 'ticket', 'delete'),
    
  // List ticket messages
  listMessages: async (request: NextRequest, ticketId: string) => {
    const result = await rateLimitMiddleware(
      request, 
      `tickets:${ticketId}:messages:list`, 
      'ticket', 
      'message' as keyof Omit<RateLimitConfigs['ticket'], 'message'>,
      'list' as keyof RateLimitConfigs['ticket']['message']
    );
    return result;
  },
    
  // Create ticket message
  createMessage: async (request: NextRequest, ticketId: string) => {
    const result = await rateLimitMiddleware(
      request, 
      `tickets:${ticketId}:messages:create`, 
      'ticket', 
      'message' as keyof Omit<RateLimitConfigs['ticket'], 'message'>,
      'create' as keyof RateLimitConfigs['ticket']['message']
    );
    return result;
  }
};

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000; // Clean up entries older than 1 hour
  
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.lastRequest < oneHourAgo) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 60 * 1000); // Run cleanup every hour
