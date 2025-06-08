import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Hash a password (for fallback or future use)
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

// Compare password with hash (for Fallon use)
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

// Generate JWT
export function generateToken(adminId: number, role: string): string {
  return jwt.sign(
    { adminId, role },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' } // Token expires in 1 hour
  );
}

// Verify JWT
export function verifyToken(token: string): { adminId: number; role: string } | null {
  try {
    return jwt.verify(token, process.env.JWT_SECRET as string) as { adminId: number; role: string };
  } catch {
    return null;
  }
}

// Generate OTP
export function generateOTP(length: number = 6): string {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}