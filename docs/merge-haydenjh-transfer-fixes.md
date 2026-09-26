# Merge notes: HaydenJH/aktualbudget transfer fixes

Merged 2026-09-18 from https://github.com/HaydenJH/aktualbudget (`main`,
commit `6bbcd36`) into this repo on branch `merge/hayden-transfer-fixes`.

The fork diverged at `a42c32b` and carried 7 commits, the substantive ones by
Hayden Harrison on 2026-06-27, 2026-06-28 and 2026-07-19. They fix BNZ
credit-card payments being imported as plain transactions and double-counted,
and tighten the post-sync duplicate cleanup so it stops deleting standing
orders and direct debits that coincidentally match a transfer.

## Result

| Check | Result |
|---|---|
| `npm test` | 146 tests pass (119 existing + 27 from the fork) |
| `npm run check` | typecheck, oxlint, oxfmt all pass |
| Existing tests changed | none |

## What was merged

### Sync logic (`server/sync.ts`)

**New: `getParticularsCardSuffix(t)`**
Extracts a 4-digit card suffix from `meta.particulars` of the exact form
`TO CARD 1234` or `FROM CARD 1234` (case-insensitive, trimmed). BNZ
mobile-banking payments to a credit card carry no `other_account`, no
`card_suffix` and no full account number, so this was the only signal
available and was previously ignored.

**Changed: `mapTransaction`**
Adds a fourth, lowest-priority transfer detection path. If none of the
existing three matched, a `TO CARD` suffix is looked up in
`cardSuffixToActualId`, excluding a self-match, and the transaction is mapped
to the Actual transfer payee. The bank leg of a card payment now becomes a
real transfer and Actual auto-creates the counterpart on the card account.

**New: `looksLikeTransfer(t)`**
A broader "transfer-like" classifier used only to gate the post-sync cleanup,
never to create transfers. Returns true for:

- anything `getOtherAccount` / `getCardSuffix` / `getParticularsCardSuffix` match
- positive `type: "CREDIT CARD"` records (a payment landing on a card arrives
  with empty meta, so type is its only signal)
- `particulars + code` that form an NZ account number after stripping any
  leading non-digit prefix. `mergeMetaAccount` only strips `TO`/`FROM`, so
  the receiving leg of an internal transfer (`EX 12-3072-`) was never
  recognised and left the receiving account doubled.

**Changed: `syncAccount` / `runSync` post-sync cleanup**
`runSync` now threads a shared `Set<string>` of Akahu `_id`s through every
`syncAccount` call. Each settled transaction that `looksLikeTransfer` is added
to the set. The post-sync cleanup then only deletes an imported transaction
that matches a transfer counterpart on date and amount **if its `imported_id`
is in that set**. Previously any coincidental date+amount match was deleted,
which removed a real standing order in the fork author's data.

### Tests (`server/sync.test.ts`)

27 new tests, all passing, in three groups: `getParticularsCardSuffix`,
`mapTransaction` › "credit card via TO CARD particulars (BNZ)", and
"transfer-like dedup filtering". They use real transaction shapes from the
fork author's BNZ account. No existing test was modified.

### Dev tooling

- `POST /api/dev/akahu-transactions` accepts `accountIds: string[]` (legacy
  single `accountId` still works), fetches accounts in parallel, and tags each
  row with its `accountId`.
- New `POST /api/dev/delete-actual-transactions` deletes Actual transactions
  for the given account IDs, optionally only those dated on or after `from`.
  Skips split children and tolerates already-deleted transfer counterparts.
  Follows the same `api.init` / `api.shutdown` pattern as the existing
  create-account endpoint.
- Dev Tools tab: Akahu account selector is now multi-select, an Account column
  appears when more than one account is loaded, and a new "Delete Actual
  Transactions" card drives the delete endpoint with a confirm dialog and an
  "ALL accounts" option.
- `.gitignore` adds `.env`.

## What was deliberately excluded

- **TLS verification bypass.** The fork set
  `NODE_TLS_REJECT_UNAUTHORIZED=0` both in the Dockerfile and at the top of
  `server/index.ts`. That disables certificate checking for every outbound
  HTTPS call in the process, including Akahu. Presumably the fork author runs
  Actual behind a self-signed certificate. Not merged. If needed, set the env
  var on the container at deploy time rather than in the image.
- **Dockerfile.** Kept ours (pnpm-based). The fork's only change was the TLS
  line above.
- **`package-lock.json`.** The fork modified it; we deleted it when moving to
  pnpm. Deleted.
- **`package.json` / `pnpm-lock.yaml`.** Kept ours. The fork's only change was
  bumping `@actual-app/api` to 26.9.0, which we already have.
- **Formatting drift.** The fork's "." commit re-indented several template
  string continuations. `oxfmt` restored our formatting.

## Conflict resolutions

| File | Conflict | Resolution |
|---|---|---|
| `server/sync.ts` (x2) | Both sides appended a parameter to `syncAccount` and its call site: ours `setStartingBalance`, theirs `transferLikeIds` | Kept both, ours first |
| `Dockerfile` | Ours pnpm rewrite vs their TLS env line | Ours |
| `package.json` | Both bumped Actual API | Ours |
| `pnpm-lock.yaml` | Add/add | Ours |
| `package-lock.json` | Deleted by us, modified by them | Deleted |

One comment in the fork said "ASB transfers to a credit card" while the code,
tests and the other comment all say BNZ. Changed to BNZ.

## Behaviour changes to be aware of

1. **Post-sync cleanup is now stricter.** An imported transaction that
   matches a transfer counterpart on date and amount is only deleted if Akahu
   meta marked it transfer-like. Any bank whose transfer legs carry no meta at
   all (no `other_account`, `card_suffix`, split account number, or
   `CREDIT CARD` type) would previously have been cleaned up and now will not
   be. Watch `server.log` for "Post-sync cleanup" lines dropping to zero on
   accounts where they used to fire, and for balance mismatch diagnoses.
2. **Positive `CREDIT CARD`-type records are transfer-like.** A refund or
   reversal coded with that type and a positive amount becomes eligible for
   deletion if a transfer counterpart with the exact same date and amount
   exists on the same account. The exact-match requirement makes this
   unlikely but not impossible.
3. **Pre-import dedup is unchanged and ungated.** `deduplicateTransfers`
   (pipeline step 4) still drops any incoming transaction that matches an
   existing transfer counterpart on date and amount, regardless of
   transfer-likeness. The fork's "transfer-like dedup filtering" tests
   simulate a gated pre-import filter, but the production code only gates the
   post-sync path. The standing-order false positive the fork fixed can
   therefore still occur at import time if the counterpart already exists
   when the account syncs. Recommended follow-up: pass the transfer-like set
   into `deduplicateTransfers` too, so both paths agree.

## Provenance

Fork commits merged (a true merge, so authorship is preserved in history):

- `2c756df` feat: implement express server for backend API and automated synchronization logic
- `0a9d267` Merge branch 'main' into transfer-issues
- `a4bffd4` .
- `9e56033` feat: enhance Akahu transactions API to support multiple account fetching and add delete functionality for Actual transactions
- `554cd8f` Merge pull request #1 from HaydenJH/transfer-issues
- `3192633` bump api version
- `6bbcd36` Merge pull request #2 from HaydenJH/transfer-issues
