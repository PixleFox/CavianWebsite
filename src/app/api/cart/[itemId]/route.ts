import { NextResponse, NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../../../../../lib/auth';

const prisma = new PrismaClient();

// Helper to get user ID from request
function getUserIdFromRequest(request: NextRequest): number | null {
  console.log('=== getUserIdFromRequest ===');
  const authHeader = request.headers.get('authorization');
  const cookies = request.headers.get('cookie') || '';
  
  console.log('Auth Header:', authHeader);
  console.log('Cookies:', cookies);

  let token: string | null = null;
  
  // Try to get token from Authorization header
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
    console.log('Token found in Authorization header');
  } 
  // Try to get token from cookies
  else {
    const tokenMatch = cookies.match(/auth_token=([^;]+)/);
    if (tokenMatch && tokenMatch[1]) {
      token = tokenMatch[1];
      console.log('Token found in cookies');
    }
  }

  if (!token) {
    console.log('No token found');
    return null;
  }

  try {
    console.log('Verifying token...');
    const payload = verifyToken(token);
    
    if (!payload || typeof payload !== 'object' || !('userId' in payload)) {
      console.error('Invalid token payload:', payload);
      return null;
    }
    
    const userId = Number(payload.userId);
    if (isNaN(userId)) {
      console.error('Invalid user ID in token:', payload.userId);
      return null;
    }
    
    console.log('Token verified. User ID:', userId);
    return userId;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

// DELETE /api/cart/[itemId]
export async function DELETE(
  request: NextRequest,
  { params }: { params: { itemId: string } }
) {
  console.log('=== START DELETE /api/cart/[itemId] ===');
  console.log('Request URL:', request.url);
  console.log('Item ID from params:', params.itemId);
  
  try {
    console.log('=== Getting user ID ===');
    const userId = getUserIdFromRequest(request);
    console.log('Extracted User ID:', userId);
    
    if (!userId) {
      console.log('No user ID found - returning 401');
      return NextResponse.json(
        { error: 'You must be signed in to modify your wishlist' },
        { status: 401 }
      );
    }

    const itemId = params.itemId;
    console.log('=== Processing item deletion ===');
    console.log('Item ID to delete:', itemId);

    // First find the item to check its quantity
    console.log('=== Looking for existing cart item ===');
    const existingItem = await prisma.cartItem.findFirst({
      where: {
        id: itemId,
        cart: { userId },
      },
    });
    
    console.log('Existing item found:', existingItem);

    if (!existingItem) {
      console.log('Item not found in wishlist');
      return NextResponse.json(
        { error: 'Item not found in wishlist' },
        { status: 404 }
      );
    }

    console.log('Existing item quantity:', existingItem.quantity);

    // If quantity is more than 1, decrement it
    if (existingItem.quantity > 1) {
      console.log('Decrementing quantity by 1');
      
      const updatedItem = await prisma.cartItem.update({
        where: { 
          id: itemId,
          cart: { userId }
        },
        data: {
          quantity: {
            decrement: 1
          }
        },
        include: {
          product: {
            select: { name: true, mainImage: true }
          },
          variant: {
            select: { color: true, size: true }
          }
        }
      });

      console.log('Successfully updated item quantity');
      console.log('New quantity:', updatedItem.quantity);
      
      const response = { 
        success: true,
        message: 'Quantity reduced by 1',
        item: {
          id: updatedItem.id,
          productId: updatedItem.productId,
          variantId: updatedItem.variantId || undefined,
          quantity: updatedItem.quantity,
          productName: updatedItem.product?.name,
          variantColor: updatedItem.variant?.color,
          variantSize: updatedItem.variant?.size,
          image: updatedItem.product?.mainImage
        }
      };
      
      console.log('Sending response:', response);
      return NextResponse.json(response);
    } else {
      // If quantity is 1, remove the item completely
      console.log('Removing item completely');
      
      await prisma.cartItem.delete({
        where: { 
          id: itemId,
          cart: { userId }
        },
      });
      
      console.log('Item successfully deleted');
      const response = { 
        success: true,
        message: 'Item removed from wishlist',
        item: { id: itemId, removed: true }
      };
      
      console.log('Sending response:', response);
      return NextResponse.json(response);
    }
  } catch (error) {
    console.error('=== ERROR in DELETE /api/cart/[itemId] ===');
    console.error('Error details:', error);
    
    // Log more details for Prisma errors
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      
      if ('code' in error) {
        console.error('Error code:', error.code);
      }
      
      if ('meta' in error) {
        console.error('Error meta:', error.meta);
      }
      
      console.error('Error stack:', error.stack);
    }
    
    return NextResponse.json(
      { 
        error: 'Failed to modify wishlist item',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  } finally {
    console.log('=== END DELETE /api/cart/[itemId] ===');
  }
}
