import { IsString, IsOptional, IsInt, Min, IsUUID } from 'class-validator';

export class AddToCartDto {
  @IsString()
  productId: string;

  @IsString()
  @IsOptional()
  variantId?: string;

  @IsInt()
  @Min(1)
  quantity: number;
}
