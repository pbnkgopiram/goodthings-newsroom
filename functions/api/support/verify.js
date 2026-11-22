// Workers-native HMAC validation, without a Node.js compatibility requirement.
const encoder = new TextEncoder();

function hexToBytes(signature) {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const keySecret = env.RAZORPAY_KEY_SECRET || '';
  if (!keySecret) {
    return Response.json({ error: 'Razorpay verification is not configured yet.' }, { status: 503 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const orderId = typeof payload.order_id === 'string' ? payload.order_id.trim() : '';
  const paymentId = typeof payload.payment_id === 'string' ? payload.payment_id.trim() : '';
  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  const amount = Number(payload.amount);
  const signatureBytes = hexToBytes(signature);

  if (!orderId || !paymentId || !signatureBytes || !Number.isFinite(amount) || amount < 50) {
    return Response.json({ error: 'Missing payment verification data.' }, { status: 400 });
  }

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(keySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, signatureBytes, encoder.encode(`${orderId}|${paymentId}`)
  );
  if (!valid) {
    return Response.json({ error: 'Payment signature verification failed.' }, { status: 400 });
  }

  // This establishes signature authenticity; payment settlement/capture status
  // must be checked with Razorpay before granting paid entitlements.
  return Response.json({ ok: true, message: 'Payment signature verified successfully.' });
}
