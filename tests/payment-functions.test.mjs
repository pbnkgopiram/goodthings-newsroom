import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { onRequest as verifyPayment } from '../functions/api/verify-payment.js';
import { onRequest as createOrder } from '../functions/api/create-order.js';

function post(body) {
  return new Request('https://example.test/api/verify-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('payment verification accepts authentic HMAC and rejects tampering', async () => {
  const secret = 'test_secret_123';
  const order_id = 'order_test';
  const payment_id = 'pay_test';
  const signature = createHmac('sha256', secret).update(`${order_id}|${payment_id}`).digest('hex');
  const env = { RAZORPAY_KEY_SECRET: secret };
  const good = await verifyPayment({ request: post({ order_id, payment_id, signature, amount: 5000 }), env });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).ok, true);
  const bad = await verifyPayment({ request: post({ order_id, payment_id: 'pay_other', signature, amount: 5000 }), env });
  assert.equal(bad.status, 400);
  const invalid = await verifyPayment({ request: post({ order_id, payment_id, signature: 'x'.repeat(64), amount: 5000 }), env });
  assert.equal(invalid.status, 400);
});

test('order creation uses Workers-compatible Basic auth without exposing the secret to the browser', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.razorpay.com/v1/orders');
    assert.equal(options.headers.Authorization, `Basic ${btoa('rzp_test:secret_test')}`);
    assert.equal(JSON.parse(options.body).amount, 5000);
    return Response.json({ id: 'order_ok', amount: 5000, currency: 'INR' });
  };
  try {
    const request = new Request('https://example.test/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 5000, currency: 'INR' }),
    });
    const response = await createOrder({ request, env: { RAZORPAY_KEY_ID: 'rzp_test', RAZORPAY_KEY_SECRET: 'secret_test' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.order_id, 'order_ok');
    assert.equal(JSON.stringify(result).includes('secret_test'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
