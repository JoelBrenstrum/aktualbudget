# Aktual Budget Sync — Development Guide

Connector that syncs NZ bank transactions from **Akahu** (open banking API) into a
self-hosted **Actual Budget** server. Express backend does the sync work; React
frontend is a config/monitoring UI.

## Commands

```bash
npm run dev        # Vite frontend (:5173) + tsx backend (:3100/:3001) concurrently
npm test           # vitest run (unit tests for pure sync logic)
npm run check      # typecheck (app + server tsconfigs) + oxlint + oxfmt check
npm run format     # oxfmt --write src/ server/
```

Always run `npm test` and `npm run check` before committing.

## Layout

- `server/sync.ts` — **the heart of the app**. All sync logic. Pure helper
  functions are exported at the top for unit testing; `syncAccount`/`runSync`
  orchestrate the pipeline.
- `server/index.ts` — Express routes, static frontend serving, console tee to
  `data/server.log`. Includes dev endpoints `POST /api/dev/akahu-transactions`
  (raw + computed views of Akahu transactions for one or more accounts) and
  `POST /api/dev/delete-actual-transactions` (wipes Actual transactions for
  selected accounts, optionally from a date, for clean-slate sync testing).
- `server/config.ts` — config persistence. Plain config in `data/config.json`;
  secrets AES-encrypted at rest in `data/secrets.enc`, unlocked with a password
  (or `ENCRYPTION_PASSWORD` env var on startup).
- `server/scheduler.ts` — node-cron wrapper for scheduled syncs.
- `src/` — React 19 + shadcn/ui + Tailwind v4 frontend.
- `data/` — **live user data** (real config, encrypted secrets, sync history,
  `server.log`, Actual budget cache in `data/actual/`). Never commit; treat as
  sensitive. `server.log` is the best source of truth when debugging real syncs.

## Domain model / invariants

- **Amounts are integer cents** in Actual (`Math.round(t.amount * 100)`); Akahu
  amounts are dollars (float).
- **Dedup key**: Akahu transaction `_id` is stored as Actual `imported_id`.
- **Transaction classes in an Actual account** (used all over sync.ts):
  - *imported/settled*: has `imported_id`, `cleared: true`
  - *pending*: no `imported_id`, no `transfer_id`, `cleared: false` — imported
    from Akahu's pending list **without** an `imported_id` because Akahu pending
    IDs are unstable until settlement; no payee is set either.
  - *transfer counterpart*: has `transfer_id`, no `imported_id` (created by
    Actual on the other side of a transfer)
  - *manual*: none of the above
  - *starting balance*: `imported_id = "aktualsync-starting-balance-<akahuAccountId>"`
- **Dates**: Akahu returns ISO/UTC; `toLocalDateStr` converts to a
  `Pacific/Auckland` YYYY-MM-DD. Akahu encodes NZ-local transaction dates as
  midnight NZ stored in UTC (e.g. `2026-07-10T12:00:00Z` = midnight July 11
  NZST — verified against a real purchase: that record was a Saturday July 11
  transaction). So the NZ conversion is **correct**; do NOT "simplify" to the
  UTC date portion — that would shift every date back a day. `created_at`
  (when the record appeared in Akahu) can lag `date` (transaction date) by
  several days — settled records are backdated.
- **Transfers** between mapped accounts are detected four ways, in priority
  order: `meta.other_account` bank number → `meta.card_suffix` (ANZ, excluding
  self-match) → merged `meta.particulars + meta.code` (split account numbers,
  only when particulars start with TO/FROM) → `meta.particulars` of the form
  `TO CARD 1234` / `FROM CARD 1234` (BNZ payments to a credit card; looked up
  via `cardSuffixToActualId`, excluding self-match).
  Detected transfers get `payee` = Actual transfer payee ID instead of `payee_name`.
- **Transfer-like** (`looksLikeTransfer`) is a deliberately broader test used
  only to gate the post-sync duplicate cleanup: anything above, plus split
  account numbers with any non-digit prefix (e.g. `EX 12-3072-`, the receiving
  leg), plus positive `type: "CREDIT CARD"` records (payments landing on a
  card, which arrive with empty meta). Only the sending leg *creates* a
  transfer; the other leg imports plain and must be reconciled away.
- **BNZ descriptions** mash payee + particulars/code/reference together;
  `getPayeeAndNotes` strips the meta fields off as a suffix.

## The sync pipeline (`syncAccount`, in order)

1. Trigger Akahu `refreshAll`, poll until accounts aren't stale (in `runSync`).
2. Fetch settled txns (paginated; Akahu `start` param is **exclusive**, so 1 day
   is subtracted) + pending txns for the account.
3. Map settled → Actual format (transfer detection, payee/notes cleanup);
   map pending → uncleared, id-less, payee-less entries.
4. Dedup settled against existing transfer counterparts (`deduplicateTransfers`,
   1:1 matching on exact date+amount).
5. `api.importTransactions([...settled, ...pending])` — one batch.
6. Pending→settled payee fixup: pendings that gained an `imported_id` during
   import (i.e. Actual merged them with a settled txn) get their payee set from
   the settled data.
7. Stale-pending cleanup: `findStalePendingTransactions` deletes uncleared
   orphans that have a same-amount settled txn within **±7 days** (fallback for
   when Actual's fuzzy merge fails). Matching is 1:1, and any orphan candidate
   that still matches Akahu's *current* pending list is protected — settlement
   can take 4+ days (Friday purchases settle Tuesday), so live pendings outlast
   several syncs. Cleanup is skipped entirely if the pending fetch failed.
8. Optional payee refresh on existing txns; starting-balance create/update;
   optional manual-txn cleanup.
9. Back in `runSync`: post-sync transfer-duplicate cleanup across accounts
   (deletes an imported txn with the same date+amount as a transfer
   counterpart, **only if** its Akahu `_id` was flagged by `looksLikeTransfer`
   during this run — standing orders and direct debits that coincidentally
   match are left alone), then balance validation against Akahu (`diagnosis`
   lines land in sync history + server.log). Note the pre-import
   `deduplicateTransfers` (step 4) is *not* gated this way.

## Actual Budget API behaviors that matter (verified in bundled loot-core)

- `importTransactions` → `reconcileTransactions` with `updateDates: false`,
  `strictIdChecking: true`. Matching: exact `imported_id` first, then **fuzzy:
  same amount, date within ±7 days**, preferring same-payee candidates, each
  existing row consumable once per batch (`hasMatched`).
- This fuzzy merge is the *primary* mechanism that resolves an imported pending
  into its settled version (sets `imported_id`, `cleared`, keeps existing date).
  The cleanup in step 7 is only the fallback and uses the same ±7-day window.
- On merge, existing (pending) fields win where set: date is kept, payee/notes
  only fill in if empty.

## Testing conventions

- Pure functions live in `sync.ts` and are tested in `sync.test.ts` with fake
  Akahu transaction builders (`rawTxn`/`enrichedTxn`). Anything touching
  `api.*` or the Akahu client is not unit-tested — keep new logic pure and
  exported where possible so it can be.
- Real-world debugging: `data/server.log` + the dev inspector endpoint.
