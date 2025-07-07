import { NextResponse } from 'next/server';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { subDays } from 'date-fns';
import { authenticateRequest } from '../../../../../../lib/api-utils';

type Period = '7d' | '30d' | '90d' | 'ytd' | '1y' | 'all';

const prisma = new PrismaClient();

async function getDateRange(period: Period = '30d') {
  const now = new Date();
  const currentYear = now.getFullYear();
  
  switch (period) {
    case '7d':
      return {
        start: subDays(now, 7),
        end: now,
        previousStart: subDays(now, 14),
        previousEnd: subDays(now, 7),
      };
    case '30d':
      return {
        start: subDays(now, 30),
        end: now,
        previousStart: subDays(now, 60),
        previousEnd: subDays(now, 30),
      };
    case '90d':
      return {
        start: subDays(now, 90),
        end: now,
        previousStart: subDays(now, 180),
        previousEnd: subDays(now, 90),
      };
    case 'ytd':
      return {
        start: new Date(currentYear, 0, 1), // Start of current year
        end: now,
        previousStart: new Date(currentYear - 1, 0, 1),
        previousEnd: new Date(currentYear - 1, now.getMonth(), now.getDate()),
      };
    case '1y':
      return {
        start: subDays(now, 365),
        end: now,
        previousStart: subDays(now, 730),
        previousEnd: subDays(now, 365),
      };
    case 'all':
    default: {
      // For 'all', we'll compare the first half vs second half of all time
      const firstOrder = await prisma.order.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      
      if (!firstOrder) {
        return {
          start: new Date(0),
          end: now,
          previousStart: new Date(0),
          previousEnd: now,
        };
      }
      
      const midPoint = new Date(
        (firstOrder.createdAt.getTime() + now.getTime()) / 2
      );
      
      return {
        start: firstOrder.createdAt,
        end: now,
        previousStart: firstOrder.createdAt,
        previousEnd: midPoint,
      };
    }
  }
}

export async function GET(request: Request) {
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
  try {
    // Authentication is already handled at the beginning of the function
    
    // Get query parameters
    const { searchParams } = new URL(request.url);
    const period = (searchParams.get('period') as Period) || '30d';

    // Get date ranges based on period
    const dateRanges = await getDateRange(period);
    
    // Fetch data in parallel
    const [
      currentPeriodData,
      previousPeriodData,
      orderCounts,
      averageOrderValue,
    ] = await Promise.all([
      // Current period data
      prisma.order.aggregate({
        where: {
          createdAt: { gte: dateRanges.start, lte: dateRanges.end },
          status: OrderStatus.DELIVERED,
        },
        _sum: { total: true },
        _count: true,
      }),

      // Previous period data for comparison
      prisma.order.aggregate({
        where: {
          createdAt: { 
            gte: dateRanges.previousStart, 
            lte: dateRanges.previousEnd 
          },
          status: OrderStatus.DELIVERED,
        },
        _sum: { total: true },
        _count: true,
      }),

      // Order status counts
      prisma.order.groupBy({
        by: ['status'],
        where: {
          createdAt: { gte: dateRanges.start, lte: dateRanges.end },
        },
        _count: true,
      }),

      // Average order value
      prisma.order.aggregate({
        where: {
          createdAt: { gte: dateRanges.start, lte: dateRanges.end },
          status: OrderStatus.DELIVERED,
        },
        _avg: { total: true },
      }),
    ]);

    // Calculate metrics
    const totalRevenue = currentPeriodData._sum?.total?.toNumber() || 0;
    const previousTotalRevenue = previousPeriodData._sum?.total?.toNumber() || 0;
    const revenueChange = previousTotalRevenue > 0 
      ? ((totalRevenue - previousTotalRevenue) / previousTotalRevenue) * 100 
      : totalRevenue > 0 ? 100 : 0;

    const totalOrders = currentPeriodData._count || 0;
    const previousTotalOrders = previousPeriodData._count || 0;
    const ordersChange = previousTotalOrders > 0 
      ? ((totalOrders - previousTotalOrders) / previousTotalOrders) * 100 
      : totalOrders > 0 ? 100 : 0;

    const avgOrderValue = averageOrderValue._avg?.total?.toNumber() || 0;
    const previousTotal = previousPeriodData._sum?.total?.toNumber() || 0;
    const previousCount = previousPeriodData._count || 0;
    const previousAvgOrderValue = previousCount > 0 
      ? previousTotal / previousCount 
      : 0;
    const avgOrderValueChange = previousAvgOrderValue > 0 
      ? ((avgOrderValue - previousAvgOrderValue) / previousAvgOrderValue) * 100 
      : avgOrderValue > 0 ? 100 : 0;

    // Prepare order status counts
    const orderStatusCounts = orderCounts.reduce((acc, { status, _count }) => ({
      ...acc,
      [status.toLowerCase()]: _count,
    }), {});

    // Prepare response
    const response = {
      success: true,
      data: {
        totalRevenue: {
          value: totalRevenue,
          change: Number(revenueChange.toFixed(1)),
          trend: revenueChange >= 0 ? 'up' : 'down',
        },
        totalOrders: {
          value: totalOrders,
          change: Number(ordersChange.toFixed(1)),
          trend: ordersChange >= 0 ? 'up' : 'down',
        },
        averageOrderValue: {
          value: Number(avgOrderValue.toFixed(2)),
          change: Number(avgOrderValueChange.toFixed(1)),
          trend: avgOrderValueChange >= 0 ? 'up' : 'down',
        },
        orderStatus: orderStatusCounts,
      },
      meta: {
        period,
        currentPeriod: {
          start: dateRanges.start.toISOString(),
          end: dateRanges.end.toISOString(),
        },
        previousPeriod: {
          start: dateRanges.previousStart.toISOString(),
          end: dateRanges.previousEnd.toISOString(),
        },
      },
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('Sales overview error:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور در دریافت اطلاعات فروش' }, // Server error
      { status: 500 }
    );
  }
}
