// n8n Code node: "One Item per Failed Charge"
// Mode: Run Once for All Items
//
// Input: one item, the Paystack "List Transactions" response
//   { status: true, message: "...", data: [ ...transactions ], meta: {...} }
// Output: one item per failed transaction, or a single { none: true } item
// so the IF node downstream can stop cleanly on quiet days.

const response = $input.first().json;
const transactions = Array.isArray(response.data) ? response.data : [];

if (transactions.length === 0) {
  return [{ json: { none: true } }];
}

return transactions.map((t) => ({
  json: {
    none: false,
    reference: t.reference,
    amount: Number(t.amount) / 100, // kobo -> naira
    currency: t.currency,
    channel: t.channel || null,
    paidAt: t.paid_at || t.paidAt || t.created_at || t.createdAt || null,
    customerEmail: (t.customer && t.customer.email) || null,
    customerName:
      [t.customer && t.customer.first_name, t.customer && t.customer.last_name]
        .filter(Boolean)
        .join(' ') || null,
    gatewayResponse: t.gateway_response || null,
  },
}));
