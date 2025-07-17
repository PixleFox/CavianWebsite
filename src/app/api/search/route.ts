import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import cacheUtils from '@lib/cache-utils';
import { productRateLimiter } from '@lib/rate-limiter';

const prisma = new PrismaClient();

// Error messages in Farsi
const MESSAGES = {
  INVALID_INPUT: 'ورودی نامعتبر است.',
  INTERNAL_ERROR: 'خطای سرور. لطفا بعدا تلاش کنید.'
} as const;

export async function GET(request: NextRequest) {
  // Apply rate limiting for search (using list endpoint for search)
  const rateLimit = await productRateLimiter.list(request);
  if (rateLimit.isRateLimited) {
    return rateLimit.response;
  }

  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim();
    
    // Validate query parameter
    if (!query || query.length < 2) {
      return NextResponse.json(
        { success: false, message: 'لطفا حداقل ۲ کاراکتر برای جستجو وارد کنید.' },
        { status: 400 }
      );
    }

    // Check if user is authenticated
    const authHeader = request.headers.get('authorization');
    const isAuthenticated = authHeader?.startsWith('Bearer ');
    
    // Build cache key
    const cacheKey = `search:${query}:${isAuthenticated ? 'auth' : 'public'}`;
    
    // Create a function to perform the search
    const performSearch = async () => {
      // Build search conditions
      const searchConditions: Prisma.ProductWhereInput = {
        OR: [
          { name: { contains: query, mode: 'insensitive' as const } },
          { description: { contains: query, mode: 'insensitive' as const } },
          { variants: { some: { 
            OR: [
              { sku: { contains: query, mode: 'insensitive' as const } },
              { barcode: { contains: query, mode: 'insensitive' as const } }
            ]
          } } }
        ]
      };

      // For non-authenticated users, only show active products
      if (!isAuthenticated) {
        searchConditions.isActive = true;
      }

      // Execute search query
      return await fetchSearchResults(searchConditions, searchParams);
    };
    
    // For non-authenticated users, try to get cached results
    if (!isAuthenticated) {
      const cachedResponse = await cacheUtils.getCachedData(cacheKey, performSearch);
      
      if (cachedResponse) {
        return NextResponse.json(cachedResponse, {
          headers: { 'X-Cache': 'HIT' }
        });
      }
    }

    // If not cached or authenticated, perform the search
    const response = await performSearch();

    return NextResponse.json(response, {
      headers: { 'X-Cache': isAuthenticated ? 'BYPASS' : 'MISS' }
    });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { success: false, message: MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    );
  }
}

// Helper function to fetch search results
async function fetchSearchResults(
  searchConditions: Prisma.ProductWhereInput,
  searchParams: URLSearchParams
) {
  const isAuthenticated = false; // We'll handle authentication at the route level
  const page = parseInt(searchParams.get('page') || '1');
  const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 50);

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where: searchConditions,
      include: {
        category: {
          select: { id: true, name: true, slug: true }
        },
        variants: {
          where: isAuthenticated ? undefined : { isActive: true },
          select: {
            id: true,
            sku: true,
            price: true,
            stock: true,
            size: true,
            color: true,
            colorHex: true,
            isActive: isAuthenticated ? true : undefined
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit
    }),
    prisma.product.count({ where: searchConditions })
  ]);

  return {
    success: true,
    data: products,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
}
