/**
 * Generates a random EAN-13 barcode
 * EAN-13 format: 
 * - 12 digits (data) + 1 check digit
 * - First 2-3 digits represent country code (we'll use 626 for Iran)
 */
export function generateBarcode(): string {
  // Start with country code for Iran (626)
  let barcode = '626';
  
  // Add random 9 digits (total 12 digits before check digit)
  for (let i = 0; i < 9; i++) {
    barcode += Math.floor(Math.random() * 10);
  }
  
  // Calculate check digit
  const checkDigit = calculateEAN13CheckDigit(barcode);
  
  return barcode + checkDigit;
}

/**
 * Calculates the check digit for an EAN-13 barcode
 * @param code 12-digit code (without check digit)
 * @returns The check digit (0-9)
 */
function calculateEAN13CheckDigit(code: string): number {
  let sum = 0;
  
  // Sum all digits at odd positions (1-based index) multiplied by 1 or 3
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code[i], 10);
    // Multiply by 1 for odd positions, 3 for even positions (0-based index)
    sum += (i % 2 === 0 ? 1 : 3) * digit;
  }
  
  // Calculate check digit
  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

/**
 * Validates if a barcode is a valid EAN-13 barcode
 */
export function isValidBarcode(barcode: string): boolean {
  // Must be 13 digits
  if (!/^\d{13}$/.test(barcode)) {
    return false;
  }
  
  // Extract check digit
  const checkDigit = parseInt(barcode[12], 10);
  const code = barcode.substring(0, 12);
  
  // Verify check digit
  return calculateEAN13CheckDigit(code) === checkDigit;
}
