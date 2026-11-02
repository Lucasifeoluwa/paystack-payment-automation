#!/usr/bin/env node
'use strict';

/**
 * Fire a signed, Paystack-style webhook at your n8n workflow.
 *
 * Usage:
 *   node scripts/send-test-webhook.js                 # valid charge.success, fresh reference
 *   node scripts/send-test-webhook.js --duplicate     # same event twice: second must be ignored
 *   node scripts/send-test-webhook.js --bad-signature # tampered signature: must be rejected
 *   node scripts/send-test-webhook.js --ref my-ref-01 # use a specific reference
 *
 * Reads PAYSTACK_SECRET_KEY and N8N_WEBHOOK_URL from the environment or .env.
 * Requires Node 18+ (built-in fetch). No dependencies.
 */

const fs = require('fs');
const path = require('path');
const { signPayload } = require('../code/verify-signature');

function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

async function send(url, rawBody, signature, label) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    body: rawBody,
  });
  console.log(`${label}: HTTP ${res.status}`);
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const url = process.env.N8N_WEBHOOK_URL;
  if (!secret || !url) {
    console.error('Set PAYSTACK_SECRET_KEY and N8N_WEBHOOK_URL (see .env.example).');
    process.exit(1);
  }
  if (secret.startsWith('sk_live_')) {
    console.error('Refusing to run with a LIVE key. Use your sk_test_ key.');
    process.exit(1);
  }

  const refIdx = args.indexOf('--ref');
  const reference = refIdx >= 0 ? args[refIdx + 1] : `demo-${Date.now()}`;

  const event = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'samples', 'charge-success.json'), 'utf8'),
  );
  event.data.reference = reference;
  event.data.paid_at = new Date().toISOString();

  const rawBody = JSON.stringify(event);
  const signature = signPayload(rawBody, secret);

  console.log(`reference: ${reference}`);

  if (args.includes('--bad-signature')) {
    const tampered = signature.slice(0, -4) + 'beef';
    await send(url, rawBody, tampered, 'bad signature (expect: Slack "rejected" alert, no Airtable row)');
    return;
  }

  await send(url, rawBody, signature, 'first delivery (expect: Airtable row + receipt + Slack)');

  if (args.includes('--duplicate')) {
    await new Promise((r) => setTimeout(r, 3000));
    await send(url, rawBody, signature, 'retry of same event (expect: ignored as duplicate)');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
