# Airtable schema

One base, one table. Create it before importing the workflows.

## Table: `Payments`

| Field | Type | Notes |
| --- | --- | --- |
| `Reference` | Single line text | **Primary field.** Paystack transaction reference. Used for duplicate checks and upserts. |
| `Status` | Single select | Options: `Success`, `Failed` |
| `Amount` | Currency (₦, 2 decimals) | Converted from kobo (Paystack sends amount × 100) |
| `Currency` | Single line text | e.g. `NGN` |
| `Channel` | Single line text | `card`, `bank`, `ussd`, `bank_transfer`, ... |
| `Customer Email` | Email | |
| `Customer Name` | Single line text | |
| `Paid At` | Date (include time, GMT) | From `data.paid_at` |
| `Gateway Response` | Single line text | Paystack's reason text, most useful on failed charges |
| `Receipt Sent` | Checkbox | Ticked after the receipt email succeeds |
| `Follow-up` | Single select | Options: `Not needed`, `Needed`, `Done`. Failed charges arrive as `Needed`. |
| `Source` | Single select | Options: `Webhook`, `Daily sweep` |

## Suggested views

- **Needs follow-up**: filter `Follow-up = Needed`, sorted by `Paid At` descending. This is the team's work queue for failed charges.
- **Today's sales**: filter `Status = Success` and `Paid At` is today.

## Why `Reference` is the primary field

Paystack retries a webhook until it gets a 200, and the same event can arrive more than once. Every write keys on `Reference`, so a retried or duplicated event never creates a second row or a second receipt.

Airtable has no unique constraint, so two deliveries of the same event landing within the same second could both pass the duplicate check. See *Known limitations* in the README.
