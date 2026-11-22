export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const keyId = env.RAZORPAY_KEY_ID || '';
  const keySecret = env.RAZORPAY_KEY_SECRET || '';

  if (!keyId || !keySecret) {
    return Response.json({ error: 'Razorpay credentials are not configured yet.' }, { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const amount = Number(payload.amount);
  const currency = typeof payload.currency === 'string' ? payload.currency.toUpperCase() : 'INR';
  const receipt = typeof payload.receipt === 'string' ? payload.receipt.trim() : `receipt-${Date.now()}`;

  if (!Number.isFinite(amount) || amount < 100 || amount > 10000000 || currency !== 'INR') {
    return Response.json({ error: 'Amount must be between ₹1 and ₹1,00,000 in INR.' }, { status: 400 });
  }

  const orderPayload = {
    amount: Math.round(amount),
    currency,
    receipt
  };

  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`
      },
      body: JSON.stringify(orderPayload)
    });

    const order = await response.json();
    if (!response.ok) {
      return Response.json(
        {
          error: order && order.error ? order.error.description : 'Unable to create Razorpay order.'
        },
        { status: response.status === 401 ? 401 : 500 }
      );
    }

    return Response.json({
      ok: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId
    });
  } catch (error) {
    return Response.json({ error: 'Unable to create Razorpay order right now.' }, { status: 500 });
  }
}
