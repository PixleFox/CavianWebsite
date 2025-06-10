// In-memory store for rate limiting
interface RateLimitEntry {
  count: number;
  lastRequest: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5;

/**
 * Check if the IP has exceeded the rate limit
 * @param ip Client IP address
 * @returns {boolean} True if rate limit is exceeded
 */
export function isRateLimited(ip: string): { isLimited: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry) {
    // First request from this IP
    rateLimitStore.set(ip, {
      count: 1,
      lastRequest: now,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
    });
    return { isLimited: false };
  }

  // Reset the counter if the window has passed
  if (now > entry.resetTime) {
    entry.count = 1;
    entry.resetTime = now + RATE_LIMIT_WINDOW_MS;
    entry.lastRequest = now;
    return { isLimited: false };
  }

  // Check if rate limit is exceeded
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return { 
      isLimited: true, 
      retryAfter: Math.ceil((entry.resetTime - now) / 1000) // in seconds
    };
  }

  // Increment the counter
  entry.count++;
  entry.lastRequest = now;
  return { isLimited: false };
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000; // Clean up entries older than 1 hour
  
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (entry.lastRequest < oneHourAgo) {
      rateLimitStore.delete(ip);
    }
  }
}, 60 * 60 * 1000); // Run cleanup every hour
