import { NextResponse } from 'next/server';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { subDays, format } from 'date-fns';
import { authenticateRequest } from '../../../../../../lib/api-utils';

type Period = '7d' | '30d' | '90d' | 'ytd' | '1y';
type Interval = 'day' | 'week' | 'month';

const prisma = new PrismaClient();

function getDateRange(period: Period = '30d') {
  const now = new Date();
  const currentYear = now.getFullYear();
  
  switch (period) {
    case '7d':
      return {
        start: subDays(now, 7),
        end: now,
      };
    case '30d':
      return {
        start: subDays(now, 30),
        end: now,
      };
    case '90d':
      return {
        start: subDays(now, 90),
        end: now,
      };
    case 'ytd':
      return {
        start: new Date(currentYear, 0, 1), // Start of current year
        end: now,
      };
    case '1y':
      return {
        start: subDays(now, 365),
        end: now,
      };
    default:
      return {
        start: subDays(now, 30),
        end: now,
      };
  }
}

function groupDataByInterval(data: Array<{ date: Date; amount: number }>, interval: Interval) {
  const grouped: Record<string, number> = {};
  
  data.forEach(({ date, amount }) => {
    let key: string;
    const d = new Date(date);
    
    switch (interval) {
      case 'day':
        key = format(d, 'yyyy-MM-dd');
        break;
      case 'week':
        // Get the start of the week (Sunday)
        const day = d.getDay();
        const diff = d.getDate() - day;
        const weekStart = new Date(d.setDate(diff));
        key = format(weekStart, 'yyyy-MM-dd');
        break;
      case 'month':
        key = format(d, 'yyyy-MM');
        break;
      default:
        key = format(d, 'yyyy-MM-dd');
    }
    
    grouped[key] = (grouped[key] || 0) + amount;
  });
  
  return grouped;
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
    // Get query parameters from the request URL
    const { searchParams } = new URL(request.url);
    const period = (searchParams.get('period') as Period) || '30d';
    const interval = (searchParams.get('interval') as Interval) || 'day';
    
    // Authentication is already handled at the beginning of the function

    // Get date range based on period
    const dateRange = getDateRange(period);
    
    // Fetch completed orders in the date range
    const orders = await prisma.order.findMany({
      where: {
        createdAt: { gte: dateRange.start, lte: dateRange.end },
        status: OrderStatus.DELIVERED,
      },
      select: {
        createdAt: true,
        total: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Process data for the chart
    const salesData = orders.map(order => ({
      date: order.createdAt,
      amount: order.total.toNumber(),
    }));

    // Group data by interval
    const groupedData = groupDataByInterval(salesData, interval);

    // Generate all intervals in the date range for complete data
    const allIntervals: string[] = [];
    const startDate = new Date(dateRange.start);
    const endDate = new Date(dateRange.end);
    
    if (interval === 'day') {
      let currentDate = startDate;
      while (currentDate <= endDate) {
        allIntervals.push(format(currentDate, 'yyyy-MM-dd'));
        currentDate = new Date(currentDate.setDate(currentDate.getDate() + 1));
      }
    } else if (interval === 'week') {
      let currentDate = startDate;
      // Move to the start of the week (Sunday)
      currentDate.setDate(currentDate.getDate() - currentDate.getDay());
      
      while (currentDate <= endDate) {
        allIntervals.push(format(currentDate, 'yyyy-MM-dd'));
        currentDate = new Date(currentDate.setDate(currentDate.getDate() + 7));
      }
    } else if (interval === 'month') {
      let currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      while (currentDate <= endDate) {
        allIntervals.push(format(currentDate, 'yyyy-MM'));
        currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
      }
    }

    // Prepare chart data with all intervals, filling in zeros where no data exists
    const chartData = allIntervals.map(interval => ({
      date: interval,
      sales: groupedData[interval] || 0,
    }));

    // Calculate total sales and change from previous period
    const totalSales = Object.values(groupedData).reduce((sum, amount) => sum + amount, 0);
    
    // Get previous period data for comparison
    const previousPeriodStart = subDays(dateRange.start, 
      Math.ceil((dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24))
    );
    
    const previousPeriodData = await prisma.order.aggregate({
      where: {
        createdAt: { gte: previousPeriodStart, lt: dateRange.start },
        status: OrderStatus.DELIVERED,
      },
      _sum: { total: true },
    });
    
    const previousTotalSales = previousPeriodData._sum?.total?.toNumber() || 0;
    const salesChange = previousTotalSales > 0 
      ? ((totalSales - previousTotalSales) / previousTotalSales) * 100 
      : totalSales > 0 ? 100 : 0;

    // Prepare response
    const response = {
      success: true,
      data: {
        chart: chartData,
        summary: {
          totalSales,
          totalOrders: orders.length,
          change: Number(salesChange.toFixed(1)),
          trend: salesChange >= 0 ? 'up' : 'down',
        },
      },
      meta: {
        period,
        interval,
        startDate: dateRange.start.toISOString(),
        endDate: dateRange.end.toISOString(),
      },
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('Sales trend error:', error);
    return NextResponse.json(
      { success: false, message: 'خطای سرور در دریافت روند فروش' }, // Server error
      { status: 500 }
    );
  }
}
