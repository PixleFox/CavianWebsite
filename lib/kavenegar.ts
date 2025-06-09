import axios from 'axios';

export async function sendOTP(phoneNumber: string, otp: string): Promise<boolean> {
  const apiKey = process.env.KAVENEGAR_API_KEY as string;
  const template = process.env.KAVENEGAR_TEMPLATE as string;

  // نرمال‌سازی شماره: تبدیل 0912... به +98912...
  const normalizedPhone = phoneNumber.startsWith('0') ? `+98${phoneNumber.slice(1)}` : phoneNumber;

  try {
    const response = await axios.post(
      `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json`,
      {},
      {
        params: {
          receptor: normalizedPhone,
          token: otp,
          template,
        },
      }
    );

    if (response.data.return.status === 200) {
      return true;
    } else {
      console.error('خطای Kavenegar:', response.data.return.message);
      return false;
    }
  } catch (error) {
    console.error('خطای درخواست Kavenegar:', error);
    return false;
  }
}