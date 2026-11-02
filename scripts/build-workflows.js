#!/usr/bin/env node
'use strict';

/**
 * Builds the n8n workflow JSON files in workflows/ from this definition.
 *
 * Why a build step: the Code-node JavaScript lives in code/ where it is
 * readable and unit tested. This script injects it into the workflow JSON,
 * so the exported workflow and the tested code can never drift apart.
 *
 *   node scripts/build-workflows.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------- shared helpers ----------

const airtableBase = { __rl: true, mode: 'id', value: '={{ $env.AIRTABLE_BASE_ID }}' };
const airtableTable = { __rl: true, mode: 'id', value: '={{ $env.AIRTABLE_PAYMENTS_TABLE_ID }}' };
const airtableCreds = { airtableTokenApi: { id: 'REPLACE_ME', name: 'Airtable account' } };
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

function slackNode(id, name, position, text) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    ...retry,
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: '={{ $env.SLACK_WEBHOOK_URL }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ text: ${text} }) }}`,
      options: {},
    },
  };
}

function ifNode(id, name, position, leftValue, operator, rightValue) {
  const condition = { id: `${id}-c1`, leftValue, operator };
  if (rightValue !== undefined) condition.rightValue = rightValue;
  return {
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [condition],
        combinator: 'and',
      },
      options: {},
    },
  };
}

// Field types for the Payments table (see airtable/schema.md). Anything not
// listed is sent as a string. Airtable rejects a string for a currency or
// checkbox field, so these must be declared.
const FIELD_TYPES = { Amount: 'number', 'Receipt Sent': 'boolean' };

// Airtable option: let Airtable coerce values (e.g. ISO date strings) into
// the column's type instead of rejecting the write.
const airtableOptions = { typecast: true };

function payments(fields) {
  // Airtable resource mapper: map these Payments columns explicitly.
  return {
    mappingMode: 'defineBelow',
    value: fields,
    matchingColumns: [],
    schema: Object.keys(fields).map((f) => ({
      id: f,
      displayName: f,
      required: false,
      defaultMatch: false,
      canBeUsedToMatch: true,
      display: true,
      type: FIELD_TYPES[f] || 'string',
      removed: false,
    })),
    attemptToConvertTypes: true,
    convertFieldsToString: false,
  };
}

const charge = "$('Verify Signature & Normalize').first().json";

// ---------- workflow 1: webhook ----------

const webhook = {
  name: 'Paystack: Payment Webhook',
  nodes: [
    {
      id: 'wh',
      name: 'Paystack Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 300],
      webhookId: 'paystack-webhook',
      parameters: {
        httpMethod: 'POST',
        path: 'paystack-webhook',
        responseMode: 'onReceived',
        options: { rawBody: true },
      },
    },
    {
      id: 'verify',
      name: 'Verify Signature & Normalize',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 300],
      parameters: { jsCode: read('code/n8n-verify-node.js') },
    },
    ifNode('ifvalid', 'Signature Valid?', [440, 300], '={{ $json.valid }}', {
      type: 'boolean',
      operation: 'true',
      singleValue: true,
    }),
    slackNode(
      'slackreject',
      'Alert: Rejected Webhook',
      [660, 520],
      '`:no_entry: Rejected Paystack webhook (${$json.reason}) at ${$json.receivedAt}`',
    ),
    ifNode(
      'ifcharge',
      'Is charge.success?',
      [660, 200],
      '={{ $json.event }}',
      { type: 'string', operation: 'equals' },
      'charge.success',
    ),
    {
      id: 'ignore',
      name: 'Ignore Other Events',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [880, 380],
      parameters: {},
    },
    {
      id: 'find',
      name: 'Find Existing Payment',
      type: 'n8n-nodes-base.airtable',
      typeVersion: 2.1,
      position: [880, 120],
      alwaysOutputData: true,
      ...retry,
      credentials: airtableCreds,
      parameters: {
        operation: 'search',
        base: airtableBase,
        table: airtableTable,
        filterByFormula: "={Reference} = '{{ $json.reference }}'",
        returnAll: false,
        limit: 1,
        options: {},
      },
    },
    ifNode('ifdup', 'Already Logged?', [1100, 120], '={{ $json.id }}', {
      type: 'string',
      operation: 'exists',
      singleValue: true,
    }),
    {
      id: 'dup',
      name: 'Duplicate: Skip',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [1320, 0],
      parameters: {},
    },
    {
      id: 'create',
      name: 'Log Sale in Airtable',
      type: 'n8n-nodes-base.airtable',
      typeVersion: 2.1,
      position: [1320, 220],
      ...retry,
      onError: 'continueErrorOutput',
      credentials: airtableCreds,
      parameters: {
        operation: 'create',
        base: airtableBase,
        table: airtableTable,
        columns: payments({
          Reference: `={{ ${charge}.reference }}`,
          Status: 'Success',
          Amount: `={{ ${charge}.amount }}`,
          Currency: `={{ ${charge}.currency }}`,
          Channel: `={{ ${charge}.channel }}`,
          'Customer Email': `={{ ${charge}.customerEmail }}`,
          'Customer Name': `={{ ${charge}.customerName }}`,
          'Paid At': `={{ ${charge}.paidAt }}`,
          'Gateway Response': `={{ ${charge}.gatewayResponse }}`,
          'Follow-up': 'Not needed',
          Source: 'Webhook',
        }),
        options: airtableOptions,
      },
    },
    {
      id: 'email',
      name: 'Send Receipt',
      type: 'n8n-nodes-base.emailSend',
      typeVersion: 2.1,
      position: [1540, 120],
      ...retry,
      onError: 'continueErrorOutput',
      credentials: { smtp: { id: 'REPLACE_ME', name: 'SMTP account' } },
      parameters: {
        fromEmail: '={{ $env.RECEIPT_FROM_EMAIL }}',
        toEmail: `={{ ${charge}.customerEmail }}`,
        subject: `=Receipt for your payment of {{ ${charge}.currency }} {{ ${charge}.amount.toLocaleString() }}`,
        emailFormat: 'html',
        html: `=<p>Hi {{ ${charge}.customerName || 'there' }},</p>
<p>Thank you for your payment. Here are the details:</p>
<ul>
  <li><strong>Amount:</strong> {{ ${charge}.currency }} {{ ${charge}.amount.toLocaleString() }}</li>
  <li><strong>Reference:</strong> {{ ${charge}.reference }}</li>
  <li><strong>Paid via:</strong> {{ ${charge}.channel }}</li>
  <li><strong>Date:</strong> {{ ${charge}.paidAt }}</li>
</ul>
<p>Keep this email as your receipt.</p>`,
        options: {},
      },
    },
    {
      id: 'tick',
      name: 'Mark Receipt Sent',
      type: 'n8n-nodes-base.airtable',
      typeVersion: 2.1,
      position: [1760, 40],
      ...retry,
      onError: 'continueRegularOutput',
      credentials: airtableCreds,
      parameters: {
        operation: 'update',
        base: airtableBase,
        table: airtableTable,
        columns: {
          ...payments({
            id: "={{ $('Log Sale in Airtable').first().json.id }}",
            'Receipt Sent': '={{ true }}',
          }),
          matchingColumns: ['id'],
        },
        options: airtableOptions,
      },
    },
    slackNode(
      'slacksale',
      'Notify Team: New Sale',
      [1980, 40],
      `\`:moneybag: New payment: \${${charge}.currency} \${${charge}.amount.toLocaleString()} from \${${charge}.customerName || ${charge}.customerEmail} (ref \${${charge}.reference})\``,
    ),
    slackNode(
      'slackemailfail',
      'Alert: Receipt Failed',
      [1760, 220],
      `\`:warning: Sale logged but receipt email failed for ref \${${charge}.reference} (\${${charge}.customerEmail}). Send it manually.\``,
    ),
    slackNode(
      'slacklogfail',
      'Alert: Could Not Log Sale',
      [1540, 380],
      `\`:rotating_light: Payment received but Airtable write failed after 3 tries. Ref \${${charge}.reference}, \${${charge}.currency} \${${charge}.amount}. Check Airtable and log it manually.\``,
    ),
  ],
  connections: {
    'Paystack Webhook': { main: [[{ node: 'Verify Signature & Normalize', type: 'main', index: 0 }]] },
    'Verify Signature & Normalize': { main: [[{ node: 'Signature Valid?', type: 'main', index: 0 }]] },
    'Signature Valid?': {
      main: [
        [{ node: 'Is charge.success?', type: 'main', index: 0 }],
        [{ node: 'Alert: Rejected Webhook', type: 'main', index: 0 }],
      ],
    },
    'Is charge.success?': {
      main: [
        [{ node: 'Find Existing Payment', type: 'main', index: 0 }],
        [{ node: 'Ignore Other Events', type: 'main', index: 0 }],
      ],
    },
    'Find Existing Payment': { main: [[{ node: 'Already Logged?', type: 'main', index: 0 }]] },
    'Already Logged?': {
      main: [
        [{ node: 'Duplicate: Skip', type: 'main', index: 0 }],
        [{ node: 'Log Sale in Airtable', type: 'main', index: 0 }],
      ],
    },
    'Log Sale in Airtable': {
      main: [
        [{ node: 'Send Receipt', type: 'main', index: 0 }],
        [{ node: 'Alert: Could Not Log Sale', type: 'main', index: 0 }],
      ],
    },
    'Send Receipt': {
      main: [
        [{ node: 'Mark Receipt Sent', type: 'main', index: 0 }],
        [{ node: 'Alert: Receipt Failed', type: 'main', index: 0 }],
      ],
    },
    'Mark Receipt Sent': { main: [[{ node: 'Notify Team: New Sale', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  active: false,
};

// ---------- workflow 2: daily failed-charge sweep ----------

const sweep = {
  name: 'Paystack: Daily Failed-Charge Sweep',
  nodes: [
    {
      id: 'sched',
      name: 'Every Day 8am',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 300],
      parameters: { rule: { interval: [{ triggerAtHour: 8 }] } },
    },
    {
      id: 'list',
      name: 'List Failed Charges (24h)',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [220, 300],
      ...retry,
      parameters: {
        method: 'GET',
        url: 'https://api.paystack.co/transaction',
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'status', value: 'failed' },
            { name: 'perPage', value: '100' },
            { name: 'from', value: '={{ $now.minus({ days: 1 }).toISO() }}' },
            { name: 'to', value: '={{ $now.toISO() }}' },
          ],
        },
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.PAYSTACK_SECRET_KEY }}' }],
        },
        options: {},
      },
    },
    {
      id: 'split',
      name: 'One Item per Failed Charge',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [440, 300],
      parameters: { jsCode: read('code/n8n-split-failed.js') },
    },
    ifNode('ifany', 'Any Failures?', [660, 300], '={{ $json.none }}', {
      type: 'boolean',
      operation: 'false',
      singleValue: true,
    }),
    {
      id: 'upsert',
      name: 'Upsert Failed Charge',
      type: 'n8n-nodes-base.airtable',
      typeVersion: 2.1,
      position: [880, 200],
      ...retry,
      credentials: airtableCreds,
      parameters: {
        operation: 'upsert',
        base: airtableBase,
        table: airtableTable,
        columns: {
          ...payments({
            Reference: '={{ $json.reference }}',
            Status: 'Failed',
            Amount: '={{ $json.amount }}',
            Currency: '={{ $json.currency }}',
            Channel: '={{ $json.channel }}',
            'Customer Email': '={{ $json.customerEmail }}',
            'Customer Name': '={{ $json.customerName }}',
            'Paid At': '={{ $json.paidAt }}',
            'Gateway Response': '={{ $json.gatewayResponse }}',
            'Follow-up': 'Needed',
            Source: 'Daily sweep',
          }),
          matchingColumns: ['Reference'],
        },
        options: airtableOptions,
      },
    },
    {
      id: 'summary',
      name: 'Build Summary',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1100, 200],
      parameters: {
        jsCode: `const charges = $('One Item per Failed Charge').all().map((i) => i.json);
const total = charges.reduce((s, c) => s + c.amount, 0);
const lines = charges
  .slice(0, 10)
  .map((c) => \`• \${c.currency} \${c.amount.toLocaleString()}: \${c.customerEmail || 'unknown'} (\${c.gatewayResponse || 'no reason'})\`);
const more = charges.length > 10 ? \`\\n…and \${charges.length - 10} more in Airtable.\` : '';
return [{ json: { text: \`:warning: \${charges.length} failed charge(s) in the last 24h, worth NGN \${total.toLocaleString()}. Marked "Needed" in Airtable.\\n\${lines.join('\\n')}\${more}\` } }];`,
      },
    },
    slackNode('slacksummary', 'Post Summary to Slack', [1320, 200], '$json.text'),
  ],
  connections: {
    'Every Day 8am': { main: [[{ node: 'List Failed Charges (24h)', type: 'main', index: 0 }]] },
    'List Failed Charges (24h)': { main: [[{ node: 'One Item per Failed Charge', type: 'main', index: 0 }]] },
    'One Item per Failed Charge': { main: [[{ node: 'Any Failures?', type: 'main', index: 0 }]] },
    'Any Failures?': { main: [[{ node: 'Upsert Failed Charge', type: 'main', index: 0 }], []] },
    'Upsert Failed Charge': { main: [[{ node: 'Build Summary', type: 'main', index: 0 }]] },
    'Build Summary': { main: [[{ node: 'Post Summary to Slack', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  active: false,
};

// Build Summary must run once, not once per upserted record.
sweep.nodes.find((n) => n.id === 'summary').executeOnce = true;

fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
fs.writeFileSync(path.join(root, 'workflows/paystack-payment-webhook.json'), JSON.stringify(webhook, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'workflows/paystack-failed-charge-sweep.json'), JSON.stringify(sweep, null, 2) + '\n');
console.log('Built workflows/paystack-payment-webhook.json and workflows/paystack-failed-charge-sweep.json');
