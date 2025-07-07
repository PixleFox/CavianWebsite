import { NextResponse } from 'next/server';
import { PrismaClient, OrderStatus, TicketStatus } from '@prisma/client';
import { subDays } from 'date-fns';
import { authenticateRequest } from '../../../../../lib/api-utils';
import { getCachedData, generateCacheKey } from '../../../../../lib/cache-utils';

const prisma = new PrismaClient();

// Cache duration in seconds (5 minutes in production, 1 minute in development)
const CACHE_DURATION = process.env.NODE_ENV === 'production' ? 300 : 60;

// Helper to calculate percentage change
function calculatePercentageChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

export async function GET(request: Request) {
  try {
    // Authenticate the request
    const auth = await authenticateRequest(request);
    if (!auth.success) {
      return auth.response || NextResponse.json(
        { 
          success: false, 
          message: auth.error || 'دسترسی غیر مجاز',
          code: 'UNAUTHORIZED'
        },
        { status: 401 }
      );
    }

    // Generate a cache key based on the request
    const cacheKey = generateCacheKey({
      path: '/api/admin-dashboard/summary',
      // Use the authenticated admin ID from the auth result
      adminId: 'adminId' in auth ? auth.adminId : 'unknown',
      // Add any other relevant parameters that affect the response
    });

    // Try to get cached data first
    const cachedData = await getCachedData(cacheKey, async () => {
      // This function will only be called if the data is not in cache
      return await fetchDashboardData();
    });

    // If we have cached data, return it
    if (cachedData) {
      const response = NextResponse.json({
        ...cachedData,
        meta: {
          ...cachedData.meta,
          cached: true,
          cacheExpiry: new Date(Date.now() + CACHE_DURATION * 1000).toISOString()
        }
      });
      
      // Set cache control headers
      response.headers.set('Cache-Control', `public, s-maxage=${CACHE_DURATION}, stale-while-revalidate=${CACHE_DURATION * 2}`);
      response.headers.set('X-Cache-Status', 'HIT');
      
      return response;
    }

    // Fetch fresh data if not in cache
    const result = await fetchDashboardData();
    
    // Return the fresh data with cache headers
    const response = NextResponse.json(result);
    
    // Set cache control headers
    response.headers.set('Cache-Control', `public, s-maxage=${CACHE_DURATION}, stale-while-revalidate=${CACHE_DURATION * 2}`);
    response.headers.set('X-Cache-Status', 'MISS');
    
    return response;

// Helper function to fetch dashboard data
async function fetchDashboardData(): Promise<{
  success: boolean;
  data: {
    sales: { total: number; change: number; trend: 'up' | 'down' };
    orders: { total: number; change: number; trend: 'up' | 'down' };
    activeUsers: { total: number; change: number; trend: 'up' | 'down' };
    pendingTickets: { total: number };
    newCustomers: { total: number; change: number; trend: 'up' | 'down' };
  };
  meta: {
    period: string;
    currentPeriod: { start: string; end: string };
    previousPeriod: { start: string; end: string };
    cached: boolean;
    timestamp: string;
  };
}> {
  // Calculate date ranges
  const now = new Date();
  const thirtyDaysAgo = subDays(now, 30);
  const sixtyDaysAgo = subDays(now, 60);

  // Fetch data in parallel
  const [
    totalSalesCurrentPeriod,
    totalSalesPreviousPeriod,
    totalOrdersCurrentPeriod,
    totalOrdersPreviousPeriod,
    activeUsersCount,
    activeUsersPreviousPeriod,
    pendingTicketsCount,
    newCustomersCurrentPeriod,
    newCustomersPreviousPeriod,
  ] = await Promise.all([
    // Total sales amount (current 30 days)
    prisma.order.aggregate({
      where: {
        createdAt: { gte: thirtyDaysAgo, lte: now },
        status: OrderStatus.DELIVERED,
      },
      _sum: { total: true },
    }),

    // Total sales amount (previous 30 days)
    prisma.order.aggregate({
      where: {
        createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
        status: OrderStatus.DELIVERED,
      },
      _sum: { total: true },
    }),

    // Total orders count (current 30 days)
    prisma.order.count({
      where: {
        createdAt: { gte: thirtyDaysAgo, lte: now },
      },
    }),

    // Total orders count (previous 30 days)
    prisma.order.count({
      where: {
        createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
    }),

    // Active users (last 30 days)
    prisma.user.count({
      where: {
        updatedAt: { gte: thirtyDaysAgo },
      },
    }),

    // Active users (previous 30 days)
    prisma.user.count({
      where: {
        updatedAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
    }),

    // Pending tickets count
    prisma.ticket.count({
      where: { status: TicketStatus.OPEN },
    }),

    // New customers (current 30 days)
    prisma.user.count({
      where: {
        createdAt: { gte: thirtyDaysAgo, lte: now },
        role: 'CUSTOMER',
      },
    }),

    // New customers (previous 30 days)
    prisma.user.count({
      where: {
        createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
        role: 'CUSTOMER',
      },
    }),
  ]);

  // Calculate metrics
  const totalSales = totalSalesCurrentPeriod._sum?.total?.toNumber() || 0;
  const previousTotalSales = totalSalesPreviousPeriod._sum?.total?.toNumber() || 0;
  const totalOrders = totalOrdersCurrentPeriod;
  const previousTotalOrders = totalOrdersPreviousPeriod;
  const newCustomers = newCustomersCurrentPeriod;
  const previousNewCustomers = newCustomersPreviousPeriod;

  // Calculate percentages
  const salesChange = calculatePercentageChange(totalSales, previousTotalSales);
  const ordersChange = calculatePercentageChange(totalOrders, previousTotalOrders);
  const customersChange = calculatePercentageChange(newCustomers, previousNewCustomers);

  // Prepare response
  return {
    success: true,
    data: {
      sales: {
        total: totalSales,
        change: salesChange,
        trend: salesChange >= 0 ? 'up' : 'down',
      },
      orders: {
        total: totalOrders,
        change: ordersChange,
        trend: ordersChange >= 0 ? 'up' : 'down',
      },
      activeUsers: {
        total: activeUsersCount,
        change: calculatePercentageChange(activeUsersCount, activeUsersPreviousPeriod),
        trend: activeUsersCount >= activeUsersPreviousPeriod ? 'up' : 'down',
      },
      pendingTickets: {
        total: pendingTicketsCount,
      },
      newCustomers: {
        total: newCustomers,
        change: customersChange,
        trend: customersChange >= 0 ? 'up' : 'down',
      },
    },
    meta: {
      period: '30d',
      currentPeriod: {
        start: thirtyDaysAgo.toISOString(),
        end: now.toISOString(),
      },
      previousPeriod: {
        start: sixtyDaysAgo.toISOString(),
        end: thirtyDaysAgo.toISOString(),
      },
      cached: false,
      timestamp: new Date().toISOString(),
    },
  };
}

  } catch (error) {
    console.error('Dashboard summary error:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور در دریافت اطلاعات دشبورد' }, // Server error
      { status: 500 }
    );
  }
}
