/**
 * Generates a random OTP (One-Time Password)
 * @param length - Length of the OTP (default: 6)
 * @returns A string containing only digits
 */
export function generateOTP(length: number = 6): string {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}

/**
 * Calculates the expiration time for an OTP
 * @param minutes - Number of minutes until expiration (default: 15)
 * @returns A Date object representing the expiration time
 */
export function getOTPExpiration(minutes: number = 15): Date {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}
