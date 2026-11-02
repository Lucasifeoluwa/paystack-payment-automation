// n8n Code node: "Verify Signature & Normalize"
// Mode: Run Once for All Items
//
// Requires on the n8n instance (see docker-compose.yml):
//   NODE_FUNCTION_ALLOW_BUILTIN=crypto     -> lets the Code node require('crypto')
//   N8N_BLOCK_ENV_ACCESS_IN_NODE=false     -> lets the Code node read $env
//   PAYSTACK_SECRET_KEY=sk_test_...        -> your Paystack TEST secret key
//
// The Webhook node must have "Raw Body" enabled so the exact bytes Paystack
// sent are available as binary property `data`. We never re-serialise JSON
// to verify: if the raw body is missing we fail closed.

const crypto = require('crypto');
const secret = $env.PAYSTACK_SECRET_KEY;
const items = $input.all();
const results = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const headers = item.json.headers || {};
  const signature = headers['x-paystack-signature'];

  const reject = (reason) =>
    results.push({ json: { valid: false, reason, receivedAt: new Date().toISOString() } });

  if (!secret) { reject('secret_not_configured'); continue; }
  if (!signature) { reject('missing_signature'); continue; }
  if (!item.binary || !item.binary.data) { reject('raw_body_missing'); continue; }

  const raw = await this.helpers.getBinaryDataBuffer(i, 'data');
  const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).trim().toLowerCase(), 'utf8');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    reject('bad_signature');
    continue;
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    reject('invalid_json');
    continue;
  }

  const d = event.data || {};
  if (!d.reference) { reject('missing_reference'); continue; }

  results.push({
    json: {
      valid: true,
      event: event.event,
      reference: d.reference,
      status: d.status,
      amount: Number(d.amount) / 100, // kobo -> naira
      currency: d.currency,
      channel: d.channel || null,
      paidAt: d.paid_at || d.paidAt || null,
      customerEmail: (d.customer && d.customer.email) || null,
      customerName:
        [d.customer && d.customer.first_name, d.customer && d.customer.last_name]
          .filter(Boolean)
          .join(' ') || null,
      gatewayResponse: d.gateway_response || null,
    },
  });
}

return results;
