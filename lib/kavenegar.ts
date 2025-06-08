import axios from 'axios';

export async function sendOTP(phoneNumber: string, otp: string): Promise<boolean> {
  const apiKey = process.env.KAVENEGAR_API_KEY as string;
  const template = process.env.KAVENEGAR_TEMPLATE as string;

  try {
    const response = await axios.post(
      `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json`,
      {},
      {
        params: {
          receptor: phoneNumber,
          token: otp,
          template,
        },
      }
    );

    if (response.data.return.status === 200) {
      return true;
    } else {
      console.error('Kavenegar error:', response.data.return.message);
      return false;
    }
  } catch (error) {
    console.error('Kavenegar request error:', error);
    return false;
  }
}