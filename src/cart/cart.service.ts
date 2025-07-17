import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { CartResponse, CartItemResponse } from './dto/cart-response.dto';

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  private async getOrCreateCart(userId: number) {
    let cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: true,
            variant: true,
          },
        },
      },
    });

    if (!cart) {
      cart = await this.prisma.cart.create({
        data: {
          userId,
        },
        include: {
          items: {
            include: {
              product: true,
              variant: true,
            },
          },
        },
      });
    }

    return cart;
  }

  async addToCart(userId: number, addToCartDto: AddToCartDto) {
    const { productId, variantId, quantity } = addToCartDto;

    // Verify product exists
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Verify variant exists if provided
    if (variantId) {
      const variant = await this.prisma.variant.findUnique({
        where: { id: variantId, productId },
      });

      if (!variant) {
        throw new NotFoundException('Variant not found for this product');
      }
    }

    const cart = await this.getOrCreateCart(userId);

    // Check if item already exists in cart
    const existingItem = cart.items.find(
      (item) => item.productId === productId && item.variantId === variantId,
    );

    if (existingItem) {
      // Update quantity if item exists
      return this.updateCartItem(userId, existingItem.id, { quantity: existingItem.quantity + quantity });
    }

    // Add new item to cart
    const price = variantId
      ? (await this.prisma.variant.findUnique({ where: { id: variantId } })).price || product.price
      : product.price;

    await this.prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId,
        variantId,
        quantity,
        price,
      },
    });

    return this.getCart(userId);
  }

  async updateCartItem(userId: number, itemId: string, updateCartItemDto: UpdateCartItemDto) {
    const { quantity } = updateCartItemDto;

    const cart = await this.getOrCreateCart(userId);
    const item = cart.items.find((i) => i.id === itemId);

    if (!item) {
      throw new NotFoundException('Item not found in cart');
    }

    if (quantity <= 0) {
      return this.removeFromCart(userId, itemId);
    }

    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity },
    });

    return this.getCart(userId);
  }

  async removeFromCart(userId: number, itemId: string) {
    const cart = await this.getOrCreateCart(userId);
    const item = cart.items.find((i) => i.id === itemId);

    if (!item) {
      throw new NotFoundException('Item not found in cart');
    }

    await this.prisma.cartItem.delete({
      where: { id: itemId },
    });

    return this.getCart(userId);
  }

  async getCart(userId: number): Promise<CartResponse> {
    const cart = await this.getOrCreateCart(userId);

    const items: CartItemResponse[] = await Promise.all(
      cart.items.map(async (item) => {
        const product = await this.prisma.product.findUnique({
          where: { id: item.productId },
          select: { name: true, mainImage: true },
        });

        let variantName: string | undefined;
        if (item.variantId) {
          const variant = await this.prisma.variant.findUnique({
            where: { id: item.variantId },
            select: { color: true, size: true },
          });
          
          if (variant) {
            const parts = [variant.color, variant.size].filter(Boolean);
            variantName = parts.join(' / ');
          }
        }

        return {
          id: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price.toNumber(),
          productName: product?.name || 'Unknown Product',
          variantName,
          image: product?.mainImage || null,
        };
      }),
    );

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    return {
      items,
      totalItems: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal,
    };
  }

  async clearCart(userId: number) {
    const cart = await this.getOrCreateCart(userId);
    
    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });

    return { success: true };
  }
}
