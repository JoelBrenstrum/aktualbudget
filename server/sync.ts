import api from "@actual-app/api";
import { AkahuClient } from "akahu";
import type { Account, Transaction } from "akahu";
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

export function toLocalDateStr(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getMerchantName(t: Transaction): string | undefined {
  if ("merchant" in t && t.merchant?.name) {
    return t.merchant.name;
  }
  return undefined;
}

export function getOtherAccount(t: Transaction): string | undefined {
  if ("meta" in t && t.meta?.other_account) {
    return t.meta.other_account;
  }
  return undefined;
}

// Map of formatted bank account number → Actual Budget transfer payee ID
export interface TransferLookup {
  bankNumberToActualId: Map<string, string>;
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
  const merchantName = getMerchantName(t);
  const otherAccount = getOtherAccount(t);

  // Check if other_account matches a mapped account → treat as transfer
  let transferPayeeId: string | undefined;
  if (otherAccount) {
    const targetActualId = transferLookup.bankNumberToActualId.get(otherAccount);
    if (targetActualId) {
      transferPayeeId = transferLookup.actualIdToTransferPayeeId.get(targetActualId);
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

  return {
    account: actualAccountId,
    date: toLocalDateStr(t.date),
    amount: Math.round(t.amount * 100),
    imported_id: t._id,
    payee_name: merchantName ?? t.description,
    notes: merchantName ? t.description : undefined,
    cleared: true,
  };
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
  for (const mapping of config.accountMappings) {
    const akahuAccount = akahuAccounts.find((a) => a._id === mapping.akahuAccountId);
    if (akahuAccount?.formatted_account) {
      bankNumberToActualId.set(akahuAccount.formatted_account, mapping.actualAccountId);
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

  return { bankNumberToActualId, actualIdToTransferPayeeId };
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

    // Log transaction types for debugging
    const typeCounts = new Map<string, number>();
    for (const t of allTransactions) {
      typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + 1);
    }
    console.log(
      `[sync] Transaction types for ${mapping.akahuAccountName}:`,
      Object.fromEntries(typeCounts),
    );

    // Transform to Actual Budget format
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

    console.log(
      `[sync] ${mapping.akahuAccountName}: ${allTransactions.length} txns, ${transferCount} mapped as transfers`,
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

    let deduped = 0;
    const filteredTransactions = actualTransactions.filter((t) => {
      // Only check for duplicates on transactions that aren't already mapped as transfers
      if (t.payee) return true;

      const isDuplicate = existingTransfers.some(
        (et) => et.date === t.date && et.amount === t.amount,
      );
      if (isDuplicate) {
        deduped++;
        console.log(
          `[sync] Skipping duplicate transfer: ${t.payee_name} $${(t.amount / 100).toFixed(2)} on ${t.date}`,
        );
      }
      return !isDuplicate;
    });

    if (deduped > 0) {
      console.log(`[sync] ${mapping.akahuAccountName}: filtered ${deduped} duplicate transfer(s)`);
    }

    const result = await api.importTransactions(mapping.actualAccountId, filteredTransactions);

    // Update starting balance from Akahu transactions (excluding deduped transfers)
    const balanceImportedId = `aktualsync-starting-balance-${mapping.akahuAccountId}`;
    if (akahuBalance != null) {
      // Sum imported txns + existing transfer counterparts (which we skipped importing)
      const importedSum = filteredTransactions.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      const transferSum = existingTransfers.reduce((sum, t) => sum + t.amount, 0);
      const transactionSum = importedSum + transferSum;
      const startingBalance = calculateStartingBalance(
        Math.round(akahuBalance * 100),
        transactionSum,
      );

      // Find oldest date from ALL Akahu transactions (not just filtered),
      // because deduped transfers still represent real transactions that
      // the starting balance must precede.
      const allDates = [
        ...actualTransactions.map((t) => t.date),
        ...existingTransfers.map((t) => t.date),
      ];
      const balanceDateStr =
        allDates.length > 0
          ? getStartingBalanceDate(
              allDates.reduce((oldest, d) => (d < oldest ? d : oldest), allDates[0]),
            )
          : today;

      console.log(
        `[sync] Starting balance calc for ${mapping.akahuAccountName}: ` +
          `akahuBalance=$${akahuBalance.toFixed(2)}, importedSum=$${(importedSum / 100).toFixed(2)}, ` +
          `transferSum=$${(transferSum / 100).toFixed(2)}, ` +
          `startingBalance=$${(startingBalance / 100).toFixed(2)}, txnCount=${filteredTransactions.length}+${existingTransfers.length}`,
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
    // Trigger Akahu to refresh bank data before syncing
    await client.accounts.refreshAll(config.akahu.userToken);
    console.log("[sync] Triggered Akahu account refresh");

    // Fetch Akahu accounts for transfer matching
    const akahuAccounts = await client.accounts.list(config.akahu.userToken);

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
