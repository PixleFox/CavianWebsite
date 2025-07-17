import { NextResponse } from 'next/server';
import prisma from '@lib/prisma';
import { z } from 'zod';

// Define the request schema
const paymentRequestSchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
  callbackUrl: z.string().url('Valid callback URL is required'),
  email: z.string().email('Valid email is required'),
  mobile: z.string().regex(/^09\d{9}$/, 'Valid Iranian mobile number is required')
});

export async function POST(request: Request) {
  try {
    // Parse and validate request body
    const body = await request.json();
    const validation = paymentRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { orderId, callbackUrl, email, mobile } = validation.data;
    
    // Get order details including total amount
    const order = await prisma.order.findUnique({
      where: { id: orderId, status: 'PENDING_PAYMENT' },
      select: { 
        id: true, 
        total: true, 
        status: true,
        orderNumber: true,
        userId: true
      }
    });

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found or already processed' },
        { status: 404 }
      );
    }

    const amount = Math.round(Number(order.total)); // Convert to number and ensure integer

    // Prepare Zarinpal request
    const zarinpalRequest = {
      merchant_id: process.env.ZARINPAL_MERCHANT_ID,
      amount: Math.round(amount), // Ensure amount is an integer for Zarinpal
      callback_url: callbackUrl,
      description: `Payment for order #${order.orderNumber}`,
      metadata: {
        mobile: mobile,
        email: email,
        orderId: orderId
      }
    };

    // Send request to Zarinpal
    const response = await fetch('https://sandbox.zarinpal.com/pg/v4/payment/request.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(zarinpalRequest)
    });

    const data = await response.json();

    if (data.data?.code !== 100) {
      console.error('Zarinpal error:', data.errors || 'Unknown error');
      return NextResponse.json(
        { 
          success: false, 
          error: 'Payment gateway error',
          details: data.errors || 'Failed to create payment request'
        },
        { status: 502 }
      );
    }

    // Update order with payment reference
    await prisma.order.update({
      where: { id: orderId },
      data: {
        paymentGateway: 'ZARINPAL',
        paymentRefNum: data.data.authority,
        paymentStatus: 'PENDING'
      }
    });

    // Return the payment URL to redirect user
    return NextResponse.json({
      success: true,
      paymentUrl: `https://sandbox.zarinpal.com/pg/StartPay/${data.data.authority}`,
      authority: data.data.authority
    });

  } catch (error) {
    console.error('Payment request error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
