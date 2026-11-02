'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyPaystackSignature, signPayload, normalizeCharge } = require('../code/verify-signature');

const SECRET = 'unit-test-secret-key';
const raw = fs.readFileSync(path.join(__dirname, '..', 'samples', 'charge-success.json'), 'utf8');

test('accepts a correctly signed payload', () => {
  assert.equal(verifyPaystackSignature(raw, signPayload(raw, SECRET), SECRET), true);
});

test('accepts an upper-case signature header', () => {
  assert.equal(verifyPaystackSignature(raw, signPayload(raw, SECRET).toUpperCase(), SECRET), true);
});

test('rejects a tampered body', () => {
  const sig = signPayload(raw, SECRET);
  const tampered = raw.replace('2500000', '9900000');
  assert.equal(verifyPaystackSignature(tampered, sig, SECRET), false);
});

test('rejects a signature made with a different key', () => {
  assert.equal(verifyPaystackSignature(raw, signPayload(raw, 'a-different-secret-key'), SECRET), false);
});

test('rejects a SHA-256 signature (common mistake)', () => {
  const sha256 = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(verifyPaystackSignature(raw, sha256, SECRET), false);
});

test('rejects re-serialised JSON (must hash raw bytes)', () => {
  const reserialised = JSON.stringify(JSON.parse(raw));
  assert.notEqual(reserialised, raw);
  assert.equal(verifyPaystackSignature(reserialised, signPayload(raw, SECRET), SECRET), false);
});

test('rejects missing or empty signature', () => {
  assert.equal(verifyPaystackSignature(raw, undefined, SECRET), false);
  assert.equal(verifyPaystackSignature(raw, '', SECRET), false);
});

test('throws when the secret is not configured', () => {
  assert.throws(() => verifyPaystackSignature(raw, 'abc', ''), /PAYSTACK_SECRET_KEY/);
});

test('normalizes a charge: kobo to naira, customer fields', () => {
  const c = normalizeCharge(JSON.parse(raw));
  assert.equal(c.reference, 'demo-ref-0001');
  assert.equal(c.amount, 25000);
  assert.equal(c.currency, 'NGN');
  assert.equal(c.customerEmail, 'ada.okafor@example.com');
  assert.equal(c.customerName, 'Ada Okafor');
});

test('normalize throws when reference is missing', () => {
  assert.throws(() => normalizeCharge({ event: 'charge.success', data: {} }), /reference/);
});
