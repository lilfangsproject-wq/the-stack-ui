# Claude — Stack break-check (self-contained)

Updated: 2026-11-20 10:57 AWST

This file lives in the **public** repo `lilfangsproject-wq/the-stack-ui` so Claude can read it **without** private `ai-workspace` GitHub access and **without** Desktop Commander.

## Unblock facts (do not ask Seth to re-do these)

1. **`THE_STACK_UI_TOKEN` already exists** on `lilfangsproject-wq/ai-workspace` Actions secrets (created 2026-11-19). Do not ask Seth to add it again.
2. **Live UI is public:** https://lilfangsproject-wq.github.io/the-stack-ui/?cloud=1  
   Source: https://github.com/lilfangsproject-wq/the-stack-ui (public). Current shell **v40.8** after sync `2026-11-20 10:57 AWST`.
3. **Desktop Commander:** only device listed is Windows `DESKTOP-KG22UF0` (offline ~138h). Mac is not enrolled. You do **not** need Desktop Commander for this UI break-check — use the public repo + live Pages URL.
4. **Private vault** (`ai-workspace`) may 404 if your Claude GitHub connector is not signed into that private repo. For this job, prefer the public `the-stack-ui` tree.

## Hard rule (what that phrase means)

**Prove E2E before PR — or it did not happen.**  
Canon: workforce rule §10.1 / `Decisions/2026-11-18 - Prove E2E before PR or it did not happen.md`.

Before claiming a Stack fix works: exercise the path Seth hits (Pages `?cloud=1`, sheet open, Hold/Resume, DM prefill, etc.), keep a receipt (screenshot, console note, commit SHA), then PR. No ship-then-test. If blocked (auth/PAT/spend), say **BLOCKED** + exact missing step.

Also standing: zero extra spend; no expanding browser-PAT; Trades Cash-Chase + WA Mining/WhatsApp are **ON HOLD**; Stack Bento + PAT interim is the active engineering lane; Nori day-to-day / Gemini escalation.

## Job (from Gemini on behalf of Seth)

Full break-check & app refinement across The Stack UI (through **v40.8**):

1. Mobile iOS Safari / PWA sheets: `#debrief-sheet`, `#workstream-sheet`, `#host-sheet` — clipping, safe-area, hit-targets, scroll lock.
2. Hold / Resume / Delete persistence; `#peer-floor` & DM auto-job-ref composer prefill; Model & Provider Quotas; Re-brief with Gemini SSE + fallback.
3. Cloud mode (`github_hub.js`) vs documented local server parity; SW cache auto-update (`sw.js`); phone UX rough edges.

## How to work without private vault access

```text
Clone/browse: https://github.com/lilfangsproject-wq/the-stack-ui
Live:         https://lilfangsproject-wq.github.io/the-stack-ui/?cloud=1
Hard-refresh: reload once after update toast / bump (SW CACHE the-stack-shell-v40.8)
```

If you need vault hub writes, ask Cursor/Nori via `#peer-floor` — do not block on Desktop Commander.

## Deliverable

Findings + PR(s) against `the-stack-ui` (or vault `Projects/The-Stack/static/` via Cursor), then ping `#dm-claude-seth` + `#peer-floor`.

## Paste-ready status line for Seth

> Unblocked: public `the-stack-ui` v40.8 + this brief. `THE_STACK_UI_TOKEN` already set. Desktop Commander Windows offline is irrelevant for UI break-check. Hard rule = prove E2E before PR.
