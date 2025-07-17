import { NextResponse } from 'next/server';
import { verifyZarinpalPayment } from '@/lib/zarinpal';
import prisma from '@lib/prisma';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const authority = searchParams.get('Authority');
  const status = searchParams.get('Status');
  const orderId = searchParams.get('orderId');
  const amount = searchParams.get('amount');

  // Validate required parameters
  if (!authority || !status || !orderId || !amount) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/checkout/error?message=Invalid payment verification parameters`
    );
  }

  try {
    // Convert amount to number (Zarinpal uses Rials, so we might need to convert to Toman if needed)
    const amountInRials = parseInt(amount);
    
    // Verify the payment with Zarinpal
    const verification = await verifyZarinpalPayment(authority, amountInRials);

    // Update order status based on verification
    const isPaymentSuccessful = verification.data.code === 100;
    
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: isPaymentSuccessful ? 'PAYMENT_RECEIVED' : 'FAILED',
        paymentStatus: isPaymentSuccessful ? 'COMPLETED' : 'FAILED',
        paymentId: verification.data.ref_id?.toString(),
        cardPan: verification.data.card_pan,
        paidAt: new Date()
      }
    });

    // Redirect based on verification result
    if (isPaymentSuccessful) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success?orderId=${orderId}`
      );
    } else {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/checkout/error?message=Payment verification failed&orderId=${orderId}`
      );
    }
  } catch (error) {
    console.error('Error processing payment verification:', error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/checkout/error?message=Error processing payment`
    );
  }
}
