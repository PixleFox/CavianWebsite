import { ProductType } from '@prisma/client';

// Map product types to their abbreviations
const PRODUCT_TYPE_ABBREVIATIONS: Record<ProductType, string> = {
  T_SHIRT: 'Tshrt',
  HOODIE: 'Hody',
  SWEATSHIRT: 'Stshrt',
  POLO: 'PLshrt',
  TANK_TOP: 'Ttop',
  LONGSLEEVE: 'LSShirt',
  MUG: 'MUG',
  SOCKS: 'Scks',
  HAT: 'HAT',
  TOTE_BAG: 'BAG',
  ACCESSORY: 'ACCS'
};

export function generateSKU(productType: ProductType, color?: string | null): string {
  // Get the abbreviation for the product type
  const typeAbbr = PRODUCT_TYPE_ABBREVIATIONS[productType] || 'PRD';
  
  // Format the color (capitalize first letter of each word and remove spaces)
  let colorPart = '';
  if (color && color.trim() !== '') {
    colorPart = color
      .trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  // Get current time in HHMMSS format
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timePart = `${hours}${minutes}${seconds}`;

  // Combine all parts
  return `${typeAbbr}${colorPart}${timePart}`;
}

// Example usage:
// const sku = generateSKU(ProductType.T_SHIRT, 'black');
// Result: 'TshrtBlack142536' (if current time is 14:25:36)
