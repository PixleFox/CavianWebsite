interface ZarinpalVerificationResponse {
  data: {
    code: number;
    message: string;
    card_hash: string;
    card_pan: string;
    ref_id: number;
    fee_type: string;
    fee: number;
  };
  errors: {
    code: number;
    message: string;
    validations?: Record<string, string[]>;
  } | null;
}

export async function verifyZarinpalPayment(
  authority: string,
  amount: number
): Promise<ZarinpalVerificationResponse> {
  const merchantId = process.env.ZARINPAL_MERCHANT_ID;
  
  const response = await fetch('https://sandbox.zarinpal.com/pg/v4/payment/verify.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      merchant_id: merchantId,
      authority: authority,
      amount: amount,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}
