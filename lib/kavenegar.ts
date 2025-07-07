// lib/kavenegar.ts
import axios from 'axios';

export async function sendOTP(phoneNumber: string, otp: string): Promise<boolean> {
  const apiKey = process.env.KAVENEGAR_API_KEY as string;
  const template = process.env.KAVENEGAR_TEMPLATE as string;

  // Normalize phone number to Kavenegar's expected format
  let normalizedPhone = phoneNumber;
  
  // Remove any non-digit characters
  normalizedPhone = normalizedPhone.replace(/\D/g, '');
  
  // Convert to Kavenegar format (989...)
  if (normalizedPhone.startsWith('0')) {
    normalizedPhone = '98' + normalizedPhone.substring(1);
  } else if (normalizedPhone.startsWith('+98')) {
    normalizedPhone = normalizedPhone.substring(1);
  } else if (normalizedPhone.startsWith('0098')) {
    normalizedPhone = normalizedPhone.substring(2);
  }

  // Ensure the number starts with 98 and has the correct length
  if (!normalizedPhone.startsWith('98') || normalizedPhone.length !== 12) {
    console.error('Invalid phone number format:', phoneNumber);
    return false;
  }

  try {
    const response = await axios.post(
      `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json`,
      {},
      {
        params: {
          receptor: normalizedPhone,
          token: otp,
          template: template,
        },
      }
    );

    return response.data.return?.status === 200;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorResponse = error && 
      typeof error === 'object' && 
      'response' in error && 
      error.response && 
      typeof error.response === 'object' && 
      'data' in error.response 
        ? error.response.data 
        : undefined;
      
    console.error('Kavenegar API error:', {
      message: errorMessage,
      response: errorResponse,
      phoneNumber: normalizedPhone
    });
    return false;
  }
}