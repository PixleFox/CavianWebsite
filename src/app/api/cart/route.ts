import { NextResponse, NextRequest } from 'next/server';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../../../../lib/auth';

// Enable debug logging
const DEBUG = process.env.NODE_ENV !== 'production';

const prisma = new PrismaClient();

// Helper to log auth details
function logAuthDetails(request: NextRequest) {
  if (!DEBUG) return;
  
  const authHeader = request.headers.get('authorization');
  console.log('=== Auth Debug ===');
  console.log('Authorization Header:', authHeader);
  
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    console.log('Token found:', token ? `${token.substring(0, 10)}...` : 'Empty token');
  } else {
    console.log('No Bearer token found in Authorization header');
  }
  console.log('==================');
}

// Helper to get user ID from request headers or cookies
function getUserIdFromRequest(request: NextRequest): number | null {
  if (DEBUG) {
    console.log('=== getUserIdFromRequest ===');
    console.log('Request Headers:', Object.fromEntries(request.headers.entries()));
  }

  try {
    let token: string | null = null;
    
    // 1. Try to get token from Authorization header
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
      if (DEBUG) console.log('Token found in Authorization header');
    } 
    // 2. If not in header, try to get from cookies
    else {
      const cookies = request.headers.get('cookie');
      if (cookies) {
        const tokenMatch = cookies.match(/auth_token=([^;]+)/);
        if (tokenMatch && tokenMatch[1]) {
          token = tokenMatch[1];
          if (DEBUG) console.log('Token found in cookies');
        }
      }
    }

    if (!token) {
      if (DEBUG) console.log('No authentication token found in headers or cookies');
      return null;
    }

    if (DEBUG) console.log('Token found, verifying...');
    const decoded = verifyToken(token);
    
    if (!decoded) {
      if (DEBUG) console.log('Token verification failed - invalid token');
      return null;
    }
    
    if (DEBUG) {
      console.log('Token decoded successfully:', { 
        userId: decoded.userId,
        role: decoded.role,
        tokenType: typeof decoded.userId,
      });
    }
    
    // Return the user ID if it exists and is a number
    const userId = decoded.userId;
    if (DEBUG) console.log('Returning userId:', userId);
    return typeof userId === 'number' ? userId : null;
    
  } catch (error) {
    if (DEBUG) {
      console.error('Error in getUserIdFromRequest:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack?.split('\n')[0]
        });
      }
    }
    return null;
  }
}

// Schema for add to wishlist request body
const addToWishlistSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  variantId: z.string().optional(),
  quantity: z.number().int().min(1).default(1), // Keeping quantity for backward compatibility
});

// No need for update schema in wishlist

// Type for cart item in response - not currently used but kept for future reference
// interface CartItemResponse {
//   id: string;
//   productId: string;
//   variantId: string | null;
//   quantity: number;
//   price: number;
//   product: {
//     id: string;
//     name: string;
//     price: number;
//     mainImage: string | null;
//   };
//   variant: {
//     id: string;
//     name: string | null;
//     price: number | null;
//   } | null;
// }

// Cart response types are now defined inline where needed

// GET /api/cart - Get user's wishlist
export async function getCart(request: NextRequest) {
  try {
    if (DEBUG) {
      console.log('=== GET /api/cart (Wishlist) ===');
      logAuthDetails(request);
    }
    
    const userId = getUserIdFromRequest(request);
    
    if (!userId) {
      if (DEBUG) console.log('No user ID found - returning 401');
      return NextResponse.json(
        { error: 'You must be signed in to view your wishlist' },
        { status: 401 }
      );
    }

    // Get or create wishlist (using cart as wishlist)
    const wishlist = await prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                mainImage: true,
              },
            },
            variant: {
              select: {
                id: true,
                color: true,
                size: true,
              },
            },
          },
        },
      },
    });

    // Format wishlist response
    const formattedWishlist = {
      items: wishlist.items.map(item => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId || undefined,
        productName: item.product?.name || 'Unknown Product',
        variantColor: item.variant?.color,
        variantSize: item.variant?.size,
        image: item.product?.mainImage || null,
        addedAt: item.createdAt.toISOString(),
      })),
      totalItems: wishlist.items.length,
    };

    return NextResponse.json(formattedWishlist);
  } catch (error) {
    console.error('Error getting wishlist:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve wishlist' },
      { status: 500 }
    );
  }
}

// POST /api/cart - Add item to wishlist with quantity
export async function addToCart(request: NextRequest) {
  try {
    console.log('=== POST /api/cart handler called ===');
    console.log('=== POST /api/cart ===');
    console.log('Request URL:', request.url);
    console.log('Request Headers:', Object.fromEntries(request.headers.entries()));
    
    const userId = getUserIdFromRequest(request);
    if (!userId) {
      console.log('No user ID found - returning 401');
      return NextResponse.json(
        { error: 'You must be signed in to add items to wishlist' },
        { status: 401 }
      );
    }
    
    console.log('User ID:', userId);

    const body = await request.json();
    const validation = addToWishlistSchema.safeParse(body);

    if (!validation.success) {
      console.log('Validation error:', validation.error);
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { productId, variantId, quantity = 1 } = validation.data;

    // Get or create wishlist (using cart as wishlist)
    const wishlist = await prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
      include: {
        items: {
          where: {
            productId,
            variantId: variantId || null,
          },
        },
      },
    });

    let wishlistItem;
    
    // Check if item already exists in wishlist
    if (wishlist.items.length > 0) {
      console.log('Updating existing wishlist item quantity');
      const existingItem = wishlist.items[0];
      
      // Update quantity of existing item
      wishlistItem = await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: {
            increment: quantity
          }
        },
        include: {
          product: {
            select: {
              name: true,
              mainImage: true,
            },
          },
          variant: {
            select: {
              color: true,
              size: true,
            },
          },
        },
      });
    } else {
      // Add new item to wishlist
      wishlistItem = await prisma.cartItem.create({
        data: {
          cartId: wishlist.id,
          productId,
          variantId: variantId || null,
          quantity,
          price: 0, // Since it's a wishlist, price might not be relevant
        },
        include: {
          product: {
            select: {
              name: true,
              mainImage: true,
            },
          },
          variant: {
            select: {
              color: true,
              size: true,
            },
          },
        },
      });
    }

    // Format the response
    const responseItem = {
      id: wishlistItem.id,
      productId: wishlistItem.productId,
      variantId: wishlistItem.variantId || undefined,
      quantity: wishlistItem.quantity,
      productName: wishlistItem.product?.name || 'Unknown Product',
      variantColor: wishlistItem.variant?.color,
      variantSize: wishlistItem.variant?.size,
      image: wishlistItem.product?.mainImage || null,
      addedAt: wishlistItem.createdAt.toISOString(),
    };

    return NextResponse.json(responseItem, { status: 201 });
  } catch (error) {
    console.error('Error adding to wishlist:', error);
    return NextResponse.json(
      { error: 'Failed to add item to wishlist' },
      { status: 500 }
    );
  }
}

// Export route handlers for Next.js 13+ App Router
export async function GET(request: NextRequest) {
  console.log('=== GET /api/cart ===');
  return getCart(request);
}

export async function POST(request: NextRequest) {
  console.log('=== POST /api/cart ===');
  return addToCart(request);
}

// Handle DELETE /api/cart/[itemId]
// DELETE /api/cart - Clear the entire wishlist
export async function DELETE(request: NextRequest) {
  try {
    console.log('=== DELETE /api/cart (Clear All) ===');
    const userId = getUserIdFromRequest(request);
    
    if (!userId) {
      return NextResponse.json(
        { error: 'You must be signed in to modify your wishlist' },
        { status: 401 }
      );
    }

    // Clear all items from the user's wishlist
    await prisma.cartItem.deleteMany({
      where: { 
        cart: { 
          userId: userId 
        } 
      },
    });

    return NextResponse.json({ 
      success: true,
      message: 'Wishlist cleared successfully',
      itemsRemoved: true
    });
  } catch (error) {
    console.error('Error modifying wishlist:', error);
    return NextResponse.json(
      { error: 'Failed to modify wishlist' },
      { status: 500 }
    );
  }
}
