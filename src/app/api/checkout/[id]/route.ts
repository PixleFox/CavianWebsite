import { NextResponse } from 'next/server'
import prisma from '@lib/prisma'
import { OrderStatus, Prisma } from '@prisma/client'

// Error response helper
const errorResponse = (status: number, message: string, details: Record<string, unknown> = {}) => {
  return NextResponse.json({
    success: false,
    error: {
      status,
      message,
      details
    }
  }, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

// Validate OrderStatus
const isValidOrderStatus = (status: string): status is OrderStatus => {
  return Object.values(OrderStatus).includes(status as OrderStatus)
}

// Validate UUID format
const isValidUUID = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(uuid)
}

// GET /api/checkout/[id] - Get order details
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const orderId = params.id
    console.log('GET /api/checkout/[id] - Order ID:', orderId)

    if (!orderId) {
      return errorResponse(400, 'شناسه سفارش اجباری است')
    }

    if (!isValidUUID(orderId)) {
      return errorResponse(400, 'شناسه سفارش نامعتبر است', {
        details: 'فرمت شناسه سفارش صحیح نمی‌باشد'
      })
    }

    console.log('Fetching order from database...')
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
    })

    if (!order) {
      console.error('Order not found with ID:', orderId)
      return errorResponse(404, 'سفارش یافت نشد')
    }

    console.log('Order found:', { id: order.id, status: order.status })
    return NextResponse.json(order)
  } catch (error) {
    console.error('Error in GET /api/checkout/[id]:', error)
    return errorResponse(500, 'خطای سرور', {
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

// PUT /api/checkout/[id] - Update order status
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const orderId = params.id
    console.log('PUT /api/checkout/[id] - Order ID:', orderId)
    
    if (!orderId) {
      return errorResponse(400, 'شناسه سفارش اجباری است')
    }

    if (!isValidUUID(orderId)) {
      return errorResponse(400, 'شناسه سفارش نامعتبر است', {
        details: 'فرمت شناسه سفارش صحیح نمی‌باشد'
      })
    }

    const body = await request.json()
    console.log('Request body:', JSON.stringify(body, null, 2))

    // Validate status if provided
    if (body.status && !isValidOrderStatus(body.status)) {
      return errorResponse(400, 'وضعیت سفارش نامعتبر است', {
        validStatuses: Object.values(OrderStatus),
        providedStatus: body.status
      })
    }

    console.log('Updating order with ID:', orderId)
    
    try {
      const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: body.status,
        paymentStatus: body.paymentStatus,
        shippingStatus: body.shippingStatus,
        history: {
          create: {
            status: body.status,
            comment: body.comment || 'وضعیت سفارش به‌روزرسانی شد',
            userId: body.userId
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
          },
          history: true
        }
      })

      console.log('Order updated successfully:', { id: order.id, newStatus: order.status })
      return NextResponse.json(order)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          return errorResponse(404, 'سفارش یافت نشد')
        } else if (error.code === 'P2002') {
          return errorResponse(409, 'تغییرات با خطا مواجه شد، لطفاً دوباره تلاش کنید')
        } else if (error.code === 'P2003') {
          return errorResponse(400, 'اطلاعات ارسالی نامعتبر است', {
            details: 'اطلاعات ارجاعی معتبر نمی‌باشد'
          })
        }
      }
      throw error
    }
  } catch (error) {
    console.error('Error in PUT /api/checkout/[id]:', error)
    
    if (error instanceof Prisma.PrismaClientValidationError) {
      return errorResponse(400, 'داده‌های ارسالی نامعتبر است', {
        details: 'لطفاً مقادیر ورودی را بررسی کنید'
      })
    }
    
    return errorResponse(500, 'خطای سرور', {
      message: error instanceof Error ? error.message : 'خطای ناشناخته رخ داد'
    })
  }
}

// DELETE /api/checkout/[id] - Cancel order
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const orderId = params.id
    console.log('DELETE /api/checkout/[id] - Order ID:', orderId)

    if (!orderId) {
      return errorResponse(400, 'شناسه سفارش اجباری است')
    }

    // First get the order to restore inventory
    console.log('Fetching order to cancel...')
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: true,
            variant: true
          }
        },
        shippingAddress: true
      }
    })

    if (!order) {
      console.error('Order not found with ID:', orderId)
      return errorResponse(404, 'سفارش یافت نشد')
    }

    console.log('Restoring inventory for order items...')
    await Promise.all(
      order.items.map(async (item) => {
        if (item.variant) {
          await prisma.variant.update({
            where: { id: item.variant.id },
            data: { stock: { increment: item.quantity } }
          })
        } else {
          await prisma.product.update({
            where: { id: item.productId },
            data: { totalStock: { increment: item.quantity } }
          })
        }
      })
    )

    console.log('Deleting order...')
    await prisma.order.delete({ where: { id: orderId } })
    
    console.log('Order cancelled successfully')
    return NextResponse.json(
      { message: 'سفارش با موفقیت لغو شد' },
      { status: 200 }
    )
  } catch (error) {
    console.error('Error in DELETE /api/checkout/[id]:', error)
    return errorResponse(500, 'خطای سرور', {
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
