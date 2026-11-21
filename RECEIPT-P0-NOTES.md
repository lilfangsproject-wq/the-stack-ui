# P0 receipt contract audit — v50.6 proof of concept

## What the current BFF proves

- `POST /api/ping` returns only a successful BFF write (`commitSha`, `message`, and sometimes `reply`). This UI labels that **Backend accepted** while the response is present in the browser session.
- A GitHub write is not adapter delivery. The current Worker has no adapter dispatch event or delivery event.
- `reply.auto === true` is an instant Worker-generated reply (including `fallback-live`), not evidence that the displayed agent received or acknowledged anything.
- Existing `heartbeats`, channel rows, and `qc_receipts` are not tied to a sent message ID, so they cannot be used as per-message delivery, acknowledgement, or completion receipts.

Accordingly, reloaded/synced messages without a receipt contract display **Receipt unavailable**. The POC deliberately does not infer success from a commit, heartbeat, inbox, or generated reply.

## Minimal backend API needed for trustworthy progress

The BFF should persist a receipt event keyed by `message_id` (the ID returned from `/api/ping`) and expose it through either `GET /api/messages` or `GET /api/receipts?message_id=…`:

```json
{
  "message_id": "uuid",
  "events": [
    { "stage": "backend_accepted", "at": "ISO-8601", "evidence": { "write_sha": "..." } },
    { "stage": "adapter_delivered", "at": "ISO-8601", "adapter": "named-adapter", "evidence": { "receipt_id": "..." } },
    { "stage": "agent_acknowledged", "at": "ISO-8601", "agent": "Claude", "evidence": { "message_id": "..." } },
    { "stage": "qc_verified", "at": "ISO-8601", "reviewer": "ChatGPT", "evidence": { "qc_receipt_id": "...", "commit_sha": "..." } }
  ]
}
```

Each event needs an attributable source, timestamp, stable ID, and evidence reference. `agent_acknowledged` must be emitted by the real adapter/agent path, and `qc_verified` must reference an independent reviewer; neither may be inferred client-side. Unknown stages must remain absent or explicitly `unknown`.

## Scope and test coverage

This UI-only POC does not call an adapter, alter BFF/Cloudflare resources, enable a queue, or spend money. `tests/receipts.test.mjs` fixtures cover local pending/queued, BFF acceptance, Worker automation, and missing receipts.
