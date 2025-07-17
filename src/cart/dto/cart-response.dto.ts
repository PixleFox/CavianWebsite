import { ApiProperty } from '@nestjs/swagger';

export class CartItemResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  productId: string;

  @ApiProperty({ required: false })
  variantId?: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  price: number;

  @ApiProperty()
  productName: string;

  @ApiProperty({ required: false })
  variantName?: string;

  @ApiProperty()
  image?: string;
}

export class CartResponse {
  @ApiProperty({ type: [CartItemResponse] })
  items: CartItemResponse[];

  @ApiProperty()
  totalItems: number;

  @ApiProperty()
  subtotal: number;
}
