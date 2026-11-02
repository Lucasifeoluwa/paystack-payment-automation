'use strict';

/**
 * Paystack webhook signature verification.
 *
 * Paystack signs every webhook with an HMAC-SHA512 of the RAW request body,
 * keyed with your secret key, hex-encoded, and sends it in the
 * `x-paystack-signature` header.
 *
 * Two mistakes break this in practice:
 *   1. Using SHA-256 (the default for most providers). Paystack uses SHA-512.
 *   2. Hashing re-serialised JSON instead of the raw bytes. JSON.stringify
 *      can reorder keys or change spacing, so the hash never matches.
 *
 * This module is the same logic used inside the n8n Code node
 * (see code/n8n-verify-node.js), pulled out so it can be unit tested.
 */

const crypto = require('crypto');

/**
 * @param {Buffer|string} rawBody   Exact bytes Paystack sent.
 * @param {string|undefined} signature  Value of the x-paystack-signature header.
 * @param {string} secret           Paystack secret key (sk_test_... or sk_live_...).
 * @returns {boolean}
 */
function verifyPaystackSignature(rawBody, signature, secret) {
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY is not set');
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');

  // timingSafeEqual throws on length mismatch, so check first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sign a payload the way Paystack does. Used by the test script and tests.
 * @param {Buffer|string} rawBody
 * @param {string} secret
 */
function signPayload(rawBody, secret) {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

/**
 * Pull the fields the workflow needs out of a verified charge.success event.
 * Amounts arrive in the lowest currency unit (kobo for NGN), so divide by 100.
 */
function normalizeCharge(event) {
  const d = event && event.data;
  if (!d || !d.reference) throw new Error('Event has no data.reference');
  return {
    event: event.event,
    reference: d.reference,
    status: d.status,
    amount: Number(d.amount) / 100,
    currency: d.currency,
    channel: d.channel || null,
    paidAt: d.paid_at || d.paidAt || null,
    customerEmail: (d.customer && d.customer.email) || null,
    customerName:
      [d.customer && d.customer.first_name, d.customer && d.customer.last_name]
        .filter(Boolean)
        .join(' ') || null,
    gatewayResponse: d.gateway_response || null,
  };
}

module.exports = { verifyPaystackSignature, signPayload, normalizeCharge };
