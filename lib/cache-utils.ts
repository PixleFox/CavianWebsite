import { cache } from 'react';
import { revalidatePath } from 'next/cache';

// Cache configuration
export const CACHE_TTL = 60 * 5; // 5 minutes in seconds
export const CACHE_TAG = 'products';

export const cacheConfig = {
  next: {
    revalidate: CACHE_TTL,
    tags: [CACHE_TAG],
  },
};

type CacheableParams = Record<string, string | number | boolean | null | undefined>;

// Function to get cached data
export const getCachedData = cache(async <T>(key: string, fetchFn: () => Promise<T>): Promise<T> => {
  // In a real implementation, you might want to use a more sophisticated cache
  // like Redis for distributed caching
  return fetchFn();
});

// Function to generate a cache key from request parameters
export function generateCacheKey(params: CacheableParams): string {
  const sortedParams = Object.entries(params)
    .filter(([key, value]) => {
      // Use key to avoid unused variable warning
      void key; // This line is just to use the key variable
      return value !== undefined && value !== null;
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
  
  return `${CACHE_TAG}:${sortedParams}`;
}

// Function to revalidate the products cache
export async function revalidateProducts() {
  try {
    revalidatePath('/api/products');
    revalidatePath('/api/products/[id]');
    revalidatePath('/api/products/[id]/variants');
  } catch (error) {
    console.error('Failed to revalidate cache:', error);
  }
}

// Function to clear cache for a specific key pattern
export async function clearCacheByPattern() {
  // Note: The pattern parameter was removed as it's not used in the current implementation
  await revalidateProducts();
}

// Export all utilities as a single object
const cacheUtils = {
  CACHE_TTL,
  CACHE_TAG,
  cacheConfig,
  getCachedData,
  generateCacheKey,
  revalidateProducts,
  clearCacheByPattern,
};

export default cacheUtils;
