// Phone number validation for Iranian phone numbers
// Supports formats: 09xxxxxxxxx, 0098xxxxxxxxx, +98xxxxxxxxx
export function validatePhoneNumber(phone: string): boolean {
  // Remove any non-digit characters
  const cleaned = phone.replace(/\D/g, '');
  
  // Check if it's a valid Iranian mobile number
  return /^(\+98|0|98|0098)?9\d{9}$/.test(cleaned);
}

// Bank card validation
export function validateBankCard(card: string): boolean {
  if (typeof card === 'undefined' || card === null || card.length !== 16) {
    return false;
  }
  
  let cardTotal = 0;
  for (let i = 0; i < 16; i += 1) {
    const c = Number(card[i]);
    if (i % 2 === 0) {
      cardTotal += ((c * 2 > 9) ? (c * 2) - 9 : (c * 2));
    } else {
      cardTotal += c;
    }
  }
  return (cardTotal % 10 === 0);
}

// National ID validation
export function validateNationalCode(code: string): boolean {
  if (code.length !== 10 || /^(\d)\1{9}$/.test(code)) return false;

  let sum = 0;
  const chars = code.split('');
  
  for (let i = 0; i < 9; i++) {
    sum += +chars[i] * (10 - i);
  }
  
  const remainder = sum % 11;
  const lastDigit = remainder < 2 ? remainder : 11 - remainder;

  return +chars[9] === lastDigit;
}
