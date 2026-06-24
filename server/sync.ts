import api from "@actual-app/api";
import { AkahuClient } from "akahu";
import type { Account, PendingTransaction, Transaction } from "akahu";
import {
  type AccountMapping,
  type AccountSyncResult,
  type AppConfig,
  type SyncHistoryEntry,
  addSyncHistoryEntry,
  getDataDir,
} from "./config.js";

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function createAkahuClient(appToken: string): AkahuClient {
  return new AkahuClient({ appToken });
}

export async function fetchAkahuAccounts(appToken: string, userToken: string): Promise<Account[]> {
  const client = createAkahuClient(appToken);
  return client.accounts.list(userToken);
}

export async function fetchActualAccounts(config: AppConfig) {
  const dataDir = getDataDir();
  try {
    await api.init({
      dataDir,
      serverURL: normalizeUrl(config.actual.serverUrl),
      password: config.actual.password,
    });
    await api.downloadBudget(config.actual.syncId, {
      password: config.actual.encryptionPassword || undefined,
    });
    const accounts = await api.getAccounts();
    await api.shutdown();
    return accounts;
  } catch (error) {
    try {
      await api.shutdown();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

// Akahu returns dates in UTC. Convert to NZ time explicitly,
// matching the official Actual Budget Akahu integration.
const dateFormatNZ = new Intl.DateTimeFormat("en-US", {
  timeZone: "Pacific/Auckland",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function toLocalDateStr(isoDate: string): string {
  const parts = dateFormatNZ.formatToParts(new Date(isoDate));
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  const year = parts.find((p) => p.type === "year")!.value;
  return `${year}-${month}-${day}`;
}

export function getMerchantName(t: Transaction): string | undefined {
  if ("merchant" in t && t.merchant?.name) {
    return t.merchant.name;
  }
  return undefined;
}

/**
 * Extract a clean payee name and notes from an Akahu transaction.
 *
 * BNZ descriptions contain the payee name + meta fields mashed together,
 * e.g. "Abel Software Limite Water CINV37202" where "Water" is
 * meta.particulars and "CINV37202" is meta.reference.
 *
 * This strips meta fields from the description to get a clean payee,
 * and builds structured notes from the meta info.
 */
export function getPayeeAndNotes(t: Transaction): { payee: string; notes: string } {
  const merchantName = getMerchantName(t);
  const meta = "meta" in t ? (t.meta as Record<string, string> | undefined) : undefined;

  // Build notes from meta fields
  const noteParts: string[] = [];
  if (meta?.particulars) noteParts.push(meta.particulars);
  if (meta?.code) noteParts.push(meta.code);
  if (meta?.reference) noteParts.push(meta.reference);
  const metaNotes = noteParts.join(" | ");

  // If merchant name exists, use it directly
  if (merchantName) {
    return { payee: merchantName, notes: metaNotes || t.description };
  }

  // Strip meta fields from description to get a clean payee name.
  // BNZ format: [payee] [particulars] [code] [reference] — strip as a suffix.
  let cleanPayee = t.description;
  if (meta) {
    const suffixParts: string[] = [];
    if (meta.particulars) suffixParts.push(meta.particulars);
    if (meta.code) suffixParts.push(meta.code);
    if (meta.reference) suffixParts.push(meta.reference);
    const suffix = suffixParts.join(" ");
    if (suffix && cleanPayee.endsWith(suffix)) {
      cleanPayee = cleanPayee.slice(0, -suffix.length).trim();
    }
  }

  // If stripping left nothing useful, fall back to original description
  if (!cleanPayee) {
    cleanPayee = t.description;
  }

  return { payee: cleanPayee, notes: metaNotes || t.description };
}

export function getOtherAccount(t: Transaction): string | undefined {
  if ("meta" in t && t.meta?.other_account) {
    return t.meta.other_account;
  }
  return undefined;
}

export function getCardSuffix(t: Transaction): string | undefined {
  if ("meta" in t && t.meta?.card_suffix) {
    return t.meta.card_suffix;
  }
  return undefined;
}

// NZ bank account format: XX-XXXX-XXXXXXX-XX
const NZ_ACCOUNT_RE = /^\d{2}-\d{4}-\d{7}-\d{2}$/;

/**
 * Try to reconstruct a bank account number from meta.particulars + meta.code.
 *
 * Some banks (e.g. ANZ) split the target account across two meta fields:
 *   particulars: "TO 12-3072- "
 *   code:        "0400082-51"
 * Combined (after stripping prefix and whitespace): "12-3072-0400082-51"
 */
export function mergeMetaAccount(t: Transaction): string | undefined {
  if (!("meta" in t) || !t.meta) return undefined;
  const meta = t.meta as Record<string, string>;
  const particulars = meta.particulars?.trim();
  const code = meta.code?.trim();
  if (!particulars || !code) return undefined;

  // Strip common prefixes like "TO ", "FROM "
  const stripped = particulars.replace(/^(?:TO|FROM)\s+/i, "");
  const merged = (stripped + code).trim();
  if (NZ_ACCOUNT_RE.test(merged)) return merged;

  return undefined;
}

// Map of formatted bank account number → Actual Budget transfer payee ID
export interface TransferLookup {
  bankNumberToActualId: Map<string, string>;
  cardSuffixToActualId: Map<string, string>;
  actualIdToTransferPayeeId: Map<string, string>;
}

export function mapTransaction(
  t: Transaction,
  actualAccountId: string,
  transferLookup: TransferLookup,
): {
  account: string;
  date: string;
  amount: number;
  imported_id: string;
  payee?: string;
  payee_name?: string;
  notes?: string;
  cleared: boolean;
} {
  const otherAccount = getOtherAccount(t);

  // Check if other_account matches a mapped account → treat as transfer
  let transferPayeeId: string | undefined;
  if (otherAccount) {
    const targetActualId = transferLookup.bankNumberToActualId.get(otherAccount);
    if (targetActualId) {
      transferPayeeId = transferLookup.actualIdToTransferPayeeId.get(targetActualId);
    }
  }

  // Fallback: ANZ transfers use meta.card_suffix instead of other_account.
  // Match card suffix to another mapped account (exclude self-matches).
  if (!transferPayeeId) {
    const cardSuffix = getCardSuffix(t);
    if (cardSuffix) {
      const targetActualId = transferLookup.cardSuffixToActualId.get(cardSuffix);
      if (targetActualId && targetActualId !== actualAccountId) {
        transferPayeeId = transferLookup.actualIdToTransferPayeeId.get(targetActualId);
      }
    }
  }

  // Fallback: some banks split the account number across meta.particulars + meta.code.
  // Only match if the merged account exists in our mapped accounts.
  if (!transferPayeeId) {
    const merged = mergeMetaAccount(t);
    if (merged) {
      const targetActualId = transferLookup.bankNumberToActualId.get(merged);
      if (targetActualId && targetActualId !== actualAccountId) {
        transferPayeeId = transferLookup.actualIdToTransferPayeeId.get(targetActualId);
      }
    }
  }

  if (transferPayeeId) {
    return {
      account: actualAccountId,
      date: toLocalDateStr(t.date),
      amount: Math.round(t.amount * 100),
      imported_id: t._id,
      payee: transferPayeeId,
      notes: t.description,
      cleared: true,
    };
  }

  const { payee, notes } = getPayeeAndNotes(t);
  return {
    account: actualAccountId,
    date: toLocalDateStr(t.date),
    amount: Math.round(t.amount * 100),
    imported_id: t._id,
    payee_name: payee,
    notes,
    cleared: true,
  };
}

/**
 * Filter out incoming transactions that match existing transfers in Actual
 * (by date + amount). Each existing transfer can only match one incoming
 * transaction to avoid incorrectly deduping multiple payments for the same
 * amount on the same day. Transactions already mapped as transfers (with a
 * payee ID) are always kept.
 */
export function deduplicateTransfers<T extends { date: string; amount: number; payee?: string }>(
  incoming: T[],
  existingTransfers: { id: string; date: string; amount: number }[],
): { filtered: T[]; deduped: number } {
  let deduped = 0;
  const matchedTransferIds = new Set<string>();
  const filtered = incoming.filter((t) => {
    // Already mapped as a transfer — always keep
    if (t.payee) return true;

    const match = existingTransfers.find(
      (et) => !matchedTransferIds.has(et.id) && et.date === t.date && et.amount === t.amount,
    );
    if (match) {
      matchedTransferIds.add(match.id);
      deduped++;
      return false;
    }
    return true;
  });
  return { filtered, deduped };
}

/**
 * Calculate the starting balance needed so that:
 * startingBalance + sum(syncedTransactions) = currentBalance
 *
 * @param akahuBalanceCents - Current Akahu balance in cents
 * @param transactionSumCents - Sum of all synced transaction amounts in cents
 */
export function calculateStartingBalance(
  akahuBalanceCents: number,
  transactionSumCents: number,
): number {
  return akahuBalanceCents - transactionSumCents;
}

/**
 * Determine if the starting balance should be updated.
 * Only update when synced transactions exist that are older than
 * (or equal to) the existing starting balance date.
 * Always update if there's no existing starting balance.
 *
 * @param oldestTransactionDate - Oldest synced transaction date (YYYY-MM-DD)
 * @param existingBalanceDate - Current starting balance date (YYYY-MM-DD), or undefined if none
 */
export function shouldUpdateStartingBalance(
  oldestTransactionDate: string,
  existingBalanceDate: string | undefined,
): boolean {
  if (!existingBalanceDate) return true;
  return oldestTransactionDate <= existingBalanceDate;
}

/**
 * Get the date for the starting balance: 1 day before the oldest transaction.
 */
export function getStartingBalanceDate(oldestTransactionDate: string): string {
  const d = new Date(oldestTransactionDate);
  d.setDate(d.getDate() - 1);
  return toLocalDateStr(d.toISOString());
}

async function buildTransferLookup(
  config: AppConfig,
  akahuAccounts: Account[],
): Promise<TransferLookup> {
  // Build bank account number → Actual account ID
  const bankNumberToActualId = new Map<string, string>();
  // Build card suffix (last 4 digits) → Actual account ID for ANZ-style transfers
  const cardSuffixToActualId = new Map<string, string>();
  for (const mapping of config.accountMappings) {
    const akahuAccount = akahuAccounts.find((a) => a._id === mapping.akahuAccountId);
    if (akahuAccount?.formatted_account) {
      bankNumberToActualId.set(akahuAccount.formatted_account, mapping.actualAccountId);
      // Extract last 4 digits as card suffix for credit card matching
      const digits = akahuAccount.formatted_account.replace(/\D/g, "");
      if (digits.length >= 4) {
        cardSuffixToActualId.set(digits.slice(-4), mapping.actualAccountId);
      }
    }
  }

  // Build Actual account ID → transfer payee ID
  const actualIdToTransferPayeeId = new Map<string, string>();
  const payees = await api.getPayees();
  for (const payee of payees) {
    if (payee.transfer_acct) {
      actualIdToTransferPayeeId.set(payee.transfer_acct, payee.id);
    }
  }

  return { bankNumberToActualId, cardSuffixToActualId, actualIdToTransferPayeeId };
}

async function syncAccount(
  client: AkahuClient,
  userToken: string,
  mapping: AccountMapping,
  syncDays: number,
  transferLookup: TransferLookup,
  akahuBalance: number | undefined,
  cleanupManual = false,
  startDateOverride?: string,
  refreshPayees = false,
): Promise<AccountSyncResult> {
  const startDateStr =
    startDateOverride ??
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - syncDays);
      return toLocalDateStr(d.toISOString());
    })();

  // Akahu's `start` param is exclusive, so subtract 1 day to include the target date
  const akahuStartDate = (() => {
    const d = new Date(startDateStr + "T00:00:00");
    d.setDate(d.getDate() - 1);
    return toLocalDateStr(d.toISOString());
  })();

  try {
    // Fetch settled transactions with pagination
    const allTransactions: Transaction[] = [];
    let cursor: string | null | undefined;

    do {
      const page = await client.accounts.listTransactions(userToken, mapping.akahuAccountId, {
        start: akahuStartDate,
        cursor: cursor ?? undefined,
      });
      allTransactions.push(...page.items);
      cursor = page.cursor.next;
    } while (cursor);

    // Fetch pending transactions (not yet settled by the bank).
    // These are imported with cleared=false and no imported_id,
    // matching the official Actual Budget Akahu integration.
    let pendingTransactions: PendingTransaction[] = [];
    try {
      pendingTransactions = await client.accounts.listPendingTransactions(
        userToken,
        mapping.akahuAccountId,
      );
    } catch (e) {
      console.log(
        `[sync] Could not fetch pending transactions for ${mapping.akahuAccountName}:`,
        e,
      );
    }

    // Log transaction types for debugging
    const typeCounts = new Map<string, number>();
    for (const t of allTransactions) {
      typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + 1);
    }
    console.log(
      `[sync] Transaction types for ${mapping.akahuAccountName}:`,
      Object.fromEntries(typeCounts),
    );

    // Transform settled transactions to Actual Budget format
    let transferCount = 0;
    const actualTransactions = allTransactions.map((t) => {
      const mapped = mapTransaction(t, mapping.actualAccountId, transferLookup);

      // Debug logging
      const otherAccount = getOtherAccount(t);
      if (otherAccount) {
        if (mapped.payee) {
          console.log(`[sync] Transfer matched: type=${t.type}, other_account=${otherAccount}`);
          transferCount++;
        } else {
          console.log(
            `[sync] other_account=${otherAccount} (type=${t.type}) — no mapped account match`,
          );
        }
      }

      return mapped;
    });

    // Transform pending transactions — no imported_id (IDs are unstable
    // until settled), cleared=false. No payee_name is set because pending
    // transactions lack merchant info and would create ugly payee entities.
    // The payee gets set when the settled version arrives (see below).
    const pendingMapped = pendingTransactions.map((t) => ({
      account: mapping.actualAccountId,
      date: toLocalDateStr(t.date),
      amount: Math.round(t.amount * 100),
      notes: t.description,
      cleared: false,
    }));

    console.log(
      `[sync] ${mapping.akahuAccountName}: ${allTransactions.length} settled, ${pendingTransactions.length} pending, ${transferCount} transfers`,
    );

    // Deduplicate: filter out Akahu transactions that match existing transfers in Actual.
    // This prevents double-counting when e.g. a credit card payment creates a transfer
    // counterpart from another account, and Akahu also reports the same payment.
    const today = toLocalDateStr(new Date().toISOString());
    const existingActualTxns = await api.getTransactions(
      mapping.actualAccountId,
      "2000-01-01",
      today,
    );
    const existingTransfers = existingActualTxns.filter((t) => t.transfer_id && !t.imported_id);

    const { filtered: filteredTransactions, deduped } = deduplicateTransfers(
      actualTransactions,
      existingTransfers,
    );

    if (deduped > 0) {
      console.log(`[sync] ${mapping.akahuAccountName}: filtered ${deduped} duplicate transfer(s)`);
    }

    // Snapshot pending transactions before import so we can detect pending→settled transitions
    const pendingBeforeImport = existingActualTxns.filter(
      (t) => !t.cleared && !t.imported_id && !t.transfer_id,
    );

    const result = await api.importTransactions(mapping.actualAccountId, [
      ...filteredTransactions,
      ...pendingMapped,
    ]);

    // Auto-update payees on pending→settled transitions.
    // When Actual merges a pending transaction with a settled one, it keeps
    // the old (missing/ugly) payee. We detect these merges and set the payee
    // from the settled transaction's merchant/clean name.
    let pendingPayeesUpdated = 0;
    if (pendingBeforeImport.length > 0) {
      const postImportTxns = await api.getTransactions(
        mapping.actualAccountId,
        "2000-01-01",
        today,
      );
      const payeeList = await api.getPayees();
      const payeeNameToId = new Map(payeeList.map((p) => [p.name, p.id]));

      for (const prev of pendingBeforeImport) {
        const current = postImportTxns.find((t) => t.id === prev.id);
        if (!current?.imported_id) continue; // still pending

        // Find the settled transaction from our batch that matched
        const settled = actualTransactions.find((t) => t.imported_id === current.imported_id);
        if (!settled?.payee_name) continue;

        let payeeId = payeeNameToId.get(settled.payee_name);
        if (!payeeId) {
          payeeId = await api.createPayee({ name: settled.payee_name });
          payeeNameToId.set(settled.payee_name, payeeId);
        }
        await api.updateTransaction(current.id, { payee: payeeId });
        pendingPayeesUpdated++;
      }

      if (pendingPayeesUpdated > 0) {
        console.log(
          `[sync] Updated ${pendingPayeesUpdated} payee(s) from pending→settled for ${mapping.akahuAccountName}`,
        );
      }
    }

    // Refresh payees on existing transactions if enabled
    let payeesUpdated = 0;
    if (refreshPayees) {
      const payeeList = await api.getPayees();
      const payeeIdToName = new Map(payeeList.map((p) => [p.id, p.name]));
      const payeeNameToId = new Map(payeeList.map((p) => [p.name, p.id]));

      for (const mapped of actualTransactions) {
        if (!mapped.imported_id || mapped.payee) continue; // skip transfers
        const existing = existingActualTxns.find((t) => t.imported_id === mapped.imported_id);
        if (!existing || !mapped.payee_name) continue;

        const existingPayeeName = existing.payee ? payeeIdToName.get(existing.payee) : undefined;
        if (existingPayeeName !== mapped.payee_name) {
          let newPayeeId = payeeNameToId.get(mapped.payee_name);
          if (!newPayeeId) {
            newPayeeId = await api.createPayee({ name: mapped.payee_name });
            payeeNameToId.set(mapped.payee_name, newPayeeId);
          }
          await api.updateTransaction(existing.id, { payee: newPayeeId });
          payeesUpdated++;
        }
      }
      if (payeesUpdated > 0) {
        console.log(
          `[sync] Refreshed ${payeesUpdated} payee names for ${mapping.akahuAccountName}`,
        );
      }
    }

    // Update starting balance from Akahu transactions (excluding deduped transfers)
    const balanceImportedId = `aktualsync-starting-balance-${mapping.akahuAccountId}`;
    if (akahuBalance != null) {
      // Sum imported txns + pending + existing transfer counterparts (which we skipped importing)
      const importedSum = filteredTransactions.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      const pendingSum = pendingMapped.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      const transferSum = existingTransfers.reduce((sum, t) => sum + t.amount, 0);
      const transactionSum = importedSum + pendingSum + transferSum;
      const startingBalance = calculateStartingBalance(
        Math.round(akahuBalance * 100),
        transactionSum,
      );

      // Starting balance date = 1 day before the sync start date.
      // This anchors to the requested sync range rather than the oldest
      // transaction found, which may be later if the start date has no txns.
      const balanceDateStr = getStartingBalanceDate(startDateStr);

      console.log(
        `[sync] Starting balance calc for ${mapping.akahuAccountName}: ` +
          `akahuBalance=$${akahuBalance.toFixed(2)}, importedSum=$${(importedSum / 100).toFixed(2)}, ` +
          `pendingSum=$${(pendingSum / 100).toFixed(2)}, transferSum=$${(transferSum / 100).toFixed(2)}, ` +
          `startingBalance=$${(startingBalance / 100).toFixed(2)}, txnCount=${filteredTransactions.length}+${pendingMapped.length}p+${existingTransfers.length}t`,
      );

      // Check if starting balance transaction already exists
      const existingBalance = existingActualTxns.find((t) => t.imported_id === balanceImportedId);

      if (existingBalance) {
        // Only update if the current sync covers back to the existing balance date.
        // A narrower lookback (e.g. 30 days after a 180-day initial sync) doesn't
        // have enough data to recalculate correctly.
        if (shouldUpdateStartingBalance(balanceDateStr, existingBalance.date)) {
          const newDate =
            balanceDateStr < existingBalance.date ? balanceDateStr : existingBalance.date;
          await api.updateTransaction(existingBalance.id, {
            amount: startingBalance,
            date: newDate,
          });
          console.log(
            `[sync] Updated starting balance for ${mapping.akahuAccountName}: $${(startingBalance / 100).toFixed(2)} (date: ${newDate})`,
          );
        } else {
          console.log(
            `[sync] Skipping starting balance update for ${mapping.akahuAccountName}: ` +
              `current lookback (${balanceDateStr}) doesn't cover existing balance (${existingBalance.date})`,
          );
        }
      } else {
        // Create new starting balance
        const categories = await api.getCategories();
        const startingBalancesCat = categories.find(
          (c) => "name" in c && c.name === "Starting Balances",
        );

        await api.importTransactions(mapping.actualAccountId, [
          {
            account: mapping.actualAccountId,
            date: balanceDateStr,
            amount: startingBalance,
            payee_name: "Starting Balance",
            notes: "Auto generated by aktualsync",
            imported_id: balanceImportedId,
            category: startingBalancesCat?.id,
            cleared: true,
          },
        ]);
        console.log(
          `[sync] Added starting balance for ${mapping.akahuAccountName}: $${(startingBalance / 100).toFixed(2)} (date: ${balanceDateStr})`,
        );
      }
    }

    // Cleanup manual transactions if enabled
    let deletedCount = 0;
    if (cleanupManual) {
      const today = toLocalDateStr(new Date().toISOString());
      const allTxns = await api.getTransactions(mapping.actualAccountId, "2000-01-01", today);
      const manualTxns = allTxns.filter((t) => !t.imported_id && !t.transfer_id);
      for (const t of manualTxns) {
        await api.deleteTransaction(t.id);
        deletedCount++;
      }
      if (deletedCount > 0) {
        console.log(
          `[sync] Cleaned up ${deletedCount} manual transactions from ${mapping.actualAccountName}`,
        );
      }
    }

    return {
      actualAccountName: mapping.actualAccountName,
      akahuAccountName: mapping.akahuAccountName,
      imported: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
      deleted: deletedCount,
      status: "success",
    };
  } catch (error) {
    return {
      actualAccountName: mapping.actualAccountName,
      akahuAccountName: mapping.akahuAccountName,
      imported: 0,
      updated: 0,
      deleted: 0,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let isSyncing = false;
let lastSyncTime: string | null = null;

export function getSyncStatus() {
  return { isSyncing, lastSyncTime };
}

export async function runSync(
  config: AppConfig,
  syncDays = 30,
  trigger: "manual" | "scheduled" = "manual",
  cleanupManual = false,
  startDate?: string,
  refreshPayees = false,
): Promise<SyncHistoryEntry> {
  if (isSyncing) {
    throw new Error("Sync is already running");
  }
  if (config.accountMappings.length === 0) {
    throw new Error("No account mappings configured");
  }

  isSyncing = true;
  const dataDir = getDataDir();
  const client = createAkahuClient(config.akahu.appToken);

  try {
    // Trigger Akahu to refresh bank data and wait for completion.
    // Without polling, we fetch stale data before banks respond.
    await client.accounts.refreshAll(config.akahu.userToken);
    console.log("[sync] Triggered Akahu account refresh, waiting for completion...");

    let akahuAccounts = await client.accounts.list(config.akahu.userToken);
    const needsRefresh = (refreshedAt?: string) => {
      if (!refreshedAt) return false;
      return Date.now() - Date.parse(refreshedAt) > 60 * 60 * 1000;
    };
    const anyStale = () =>
      akahuAccounts.some((a) => needsRefresh(a.refreshed?.transactions as string | undefined));

    for (let i = 0; i < 5 && anyStale(); i++) {
      console.log(`[sync] Waiting for refresh (attempt ${i + 1}/5)...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      akahuAccounts = await client.accounts.list(config.akahu.userToken);
    }
    // Extra settle time for transactions to propagate
    await new Promise((resolve) => setTimeout(resolve, 3000));
    console.log("[sync] Refresh complete");

    await api.init({
      dataDir,
      serverURL: normalizeUrl(config.actual.serverUrl),
      password: config.actual.password,
    });
    await api.downloadBudget(config.actual.syncId, {
      password: config.actual.encryptionPassword || undefined,
    });

    // Build transfer lookup: bank account numbers → Actual transfer payees
    const transferLookup = await buildTransferLookup(config, akahuAccounts);
    console.log(
      `[sync] Transfer lookup: ${transferLookup.bankNumberToActualId.size} bank accounts, ${transferLookup.actualIdToTransferPayeeId.size} transfer payees`,
    );
    console.log(`[sync] Mapped bank numbers:`, [...transferLookup.bankNumberToActualId.keys()]);

    const results: AccountSyncResult[] = [];
    for (const mapping of config.accountMappings) {
      if (mapping.enabled === false) {
        console.log(`[sync] Skipping disabled account: ${mapping.akahuAccountName}`);
        continue;
      }
      const akahuAccount = akahuAccounts.find((a) => a._id === mapping.akahuAccountId);
      const result = await syncAccount(
        client,
        config.akahu.userToken,
        mapping,
        syncDays,
        transferLookup,
        akahuAccount?.balance?.current,
        cleanupManual,
        startDate,
        refreshPayees,
      );
      results.push(result);
      console.log(
        `[sync] ${mapping.akahuAccountName} → ${mapping.actualAccountName}: ` +
          `${result.imported} imported, ${result.updated} updated, ${result.deleted} deleted (${result.status})`,
      );
    }

    // Post-sync cleanup: remove imported transactions that duplicate transfer counterparts.
    // This catches cases where the pre-import dedup missed (e.g. credit card synced before
    // the source account, so no transfer existed yet during the credit card's sync).
    const enabledMappings = config.accountMappings.filter((m) => m.enabled !== false);
    const today = toLocalDateStr(new Date().toISOString());
    for (const mapping of enabledMappings) {
      const txns = await api.getTransactions(mapping.actualAccountId, "2000-01-01", today);
      const transfers = txns.filter((t) => t.transfer_id && !t.imported_id);
      const imported = txns.filter((t) => t.imported_id && !t.transfer_id);

      for (const transfer of transfers) {
        const duplicate = imported.find(
          (t) => t.date === transfer.date && t.amount === transfer.amount,
        );
        if (duplicate) {
          await api.deleteTransaction(duplicate.id);
          console.log(
            `[sync] Post-sync cleanup: removed duplicate on ${mapping.actualAccountName}: ` +
              `$${(duplicate.amount / 100).toFixed(2)} on ${duplicate.date} (kept transfer)`,
          );
        }
      }
    }

    // Post-sync validation: compare Actual balances against Akahu
    for (const mapping of enabledMappings) {
      const akahuAccount = akahuAccounts.find((a) => a._id === mapping.akahuAccountId);
      if (akahuAccount?.balance?.current == null) continue;

      const akahuBalanceCents = Math.round(akahuAccount.balance.current * 100);
      const allTxns = await api.getTransactions(mapping.actualAccountId, "2000-01-01", today);
      const actualBalanceCents = allTxns.reduce((sum, t) => sum + t.amount, 0);
      const diffCents = actualBalanceCents - akahuBalanceCents;
      const matched = diffCents === 0;

      const diagnosis: string[] = [];
      if (!matched) {
        // Categorize transactions
        const startingBalTxn = allTxns.find((t) =>
          t.imported_id?.startsWith("aktualsync-starting-balance"),
        );
        const importedTxns = allTxns.filter(
          (t) => t.imported_id && !t.imported_id.startsWith("aktualsync-starting-balance"),
        );
        const transferTxns = allTxns.filter((t) => t.transfer_id && !t.imported_id);
        const pendingTxns = allTxns.filter((t) => !t.imported_id && !t.transfer_id && !t.cleared);
        const manualTxns = allTxns.filter((t) => !t.imported_id && !t.transfer_id && t.cleared);

        diagnosis.push(
          `${importedTxns.length} imported, ${pendingTxns.length} pending, ${transferTxns.length} transfer counterparts, ${manualTxns.length} manual`,
        );

        if (startingBalTxn) {
          diagnosis.push(
            `Starting balance: $${(startingBalTxn.amount / 100).toFixed(2)} on ${startingBalTxn.date}`,
          );
        } else {
          diagnosis.push("No starting balance transaction found");
        }

        if (pendingTxns.length > 0) {
          const pendingSum = pendingTxns.reduce((s, t) => s + t.amount, 0);
          diagnosis.push(
            `Pending transactions total: $${(pendingSum / 100).toFixed(2)} (${pendingTxns.length} txns)`,
          );
        }

        if (manualTxns.length > 0) {
          const manualSum = manualTxns.reduce((s, t) => s + t.amount, 0);
          diagnosis.push(
            `Manual transactions total: $${(manualSum / 100).toFixed(2)} (${manualTxns.length} txns)`,
          );
        }

        if (transferTxns.length > 0) {
          const transferSum = transferTxns.reduce((s, t) => s + t.amount, 0);
          diagnosis.push(
            `Transfer counterparts total: $${(transferSum / 100).toFixed(2)} (${transferTxns.length} txns)`,
          );
        }

        // Check for duplicate imported_ids
        const importedIds = importedTxns.map((t) => t.imported_id).filter(Boolean);
        const seen = new Set<string>();
        const dupes = new Set<string>();
        for (const id of importedIds) {
          if (seen.has(id!)) dupes.add(id!);
          seen.add(id!);
        }
        if (dupes.size > 0) {
          diagnosis.push(`${dupes.size} duplicate imported_id(s) found`);
        }
      }

      const validation = { akahuBalanceCents, actualBalanceCents, diffCents, matched, diagnosis };

      // Attach to the matching result
      const resultEntry = results.find((r) => r.actualAccountName === mapping.actualAccountName);
      if (resultEntry) {
        resultEntry.balanceValidation = validation;
      }

      if (matched) {
        console.log(
          `[sync] ✅ ${mapping.actualAccountName}: balance matches Akahu ($${(akahuBalanceCents / 100).toFixed(2)})`,
        );
      } else {
        console.log(
          `[sync] ⚠️ Balance mismatch for ${mapping.actualAccountName}: ` +
            `Actual=$${(actualBalanceCents / 100).toFixed(2)}, ` +
            `Akahu=$${(akahuBalanceCents / 100).toFixed(2)}, ` +
            `diff=$${(diffCents / 100).toFixed(2)}`,
        );
        for (const line of diagnosis) {
          console.log(`[sync]   ${line}`);
        }
      }
    }

    await api.shutdown();

    const entry: SyncHistoryEntry = {
      timestamp: new Date().toISOString(),
      trigger,
      accounts: results,
    };

    addSyncHistoryEntry(entry);
    lastSyncTime = entry.timestamp;
    return entry;
  } catch (error) {
    try {
      await api.shutdown();
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    isSyncing = false;
  }
}
