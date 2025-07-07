/**
 * Normalizes phone number to international format with +98 prefix
 * Examples:
 * 09128442592 -> +989128442592
 * 989128442592 -> +989128442592
 * 9128442592 -> +989128442592
 * +989128442592 -> +989128442592
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return phone;
  
  // Remove all non-digit characters
  const clean = phone.replace(/\D/g, '');
  
  // Handle different formats
  if (clean.startsWith('98')) {
    return `+${clean}`;
  } else if (clean.startsWith('0')) {
    return `+98${clean.substring(1)}`;
  } else if (clean.startsWith('+98')) {
    return phone; // Already in correct format
  } else if (clean.length === 10 && clean.startsWith('9')) {
    return `+98${clean}`;
  } else if (clean.length === 11 && clean.startsWith('0')) {
    return `+98${clean.substring(1)}`;
  }
  
  // If we can't normalize it, return as is
  return phone;
}

/**
 * Normalizes phone number for database storage (without +)
 * This ensures consistent storage format in the database
 */
export function normalizeForDb(phone: string): string {
  if (!phone) return phone;
  const normalized = normalizePhoneNumber(phone);
  return normalized.startsWith('+') ? normalized.substring(1) : normalized;
}

/**
 * Compares two phone numbers after normalization
 */
export function comparePhoneNumbers(phone1: string, phone2: string): boolean {
  if (!phone1 || !phone2) return false;
  return normalizeForDb(phone1) === normalizeForDb(phone2);
}
