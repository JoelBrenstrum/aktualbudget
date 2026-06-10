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
): Promise<AccountSyncResult> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - syncDays);
  const startDateStr = toLocalDateStr(startDate.toISOString());

  try {
    // Fetch settled transactions with pagination
    const allTransactions: Transaction[] = [];
    let cursor: string | null | undefined;

    do {
      const page = await client.accounts.listTransactions(userToken, mapping.akahuAccountId, {
        start: startDateStr,
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

    const result = await api.importTransactions(mapping.actualAccountId, actualTransactions);

    // Add starting balance if this is the first sync for this account
    const balanceImportedId = `aktualsync-starting-balance-${mapping.akahuAccountId}`;
    if (akahuBalance != null && (result.added?.length ?? 0) > 0) {
      // Check if starting balance already exists by trying to import with same imported_id
      const transactionSum = actualTransactions.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      const startingBalance = Math.round(akahuBalance * 100) - transactionSum;

      const balanceDate = new Date();
      balanceDate.setDate(balanceDate.getDate() - (syncDays + 1));
      const balanceDateStr = toLocalDateStr(balanceDate.toISOString());

      // Find the "Starting Balances" category
      const categories = await api.getCategories();
      const startingBalancesCat = categories.find(
        (c) => "name" in c && c.name === "Starting Balances",
      );

      const balanceResult = await api.importTransactions(mapping.actualAccountId, [
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

      if (balanceResult.added?.length) {
        console.log(
          `[sync] Added starting balance for ${mapping.akahuAccountName}: $${(startingBalance / 100).toFixed(2)} (akahu=$${akahuBalance.toFixed(2)}, txn_sum=$${(transactionSum / 100).toFixed(2)})`,
        );
      }
    }

    return {
      actualAccountName: mapping.actualAccountName,
      akahuAccountName: mapping.akahuAccountName,
      imported: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
      status: "success",
    };
  } catch (error) {
    return {
      actualAccountName: mapping.actualAccountName,
      akahuAccountName: mapping.akahuAccountName,
      imported: 0,
      updated: 0,
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
      const akahuAccount = akahuAccounts.find((a) => a._id === mapping.akahuAccountId);
      const result = await syncAccount(
        client,
        config.akahu.userToken,
        mapping,
        syncDays,
        transferLookup,
        akahuAccount?.balance?.current,
      );
      results.push(result);
      console.log(
        `[sync] ${mapping.akahuAccountName} → ${mapping.actualAccountName}: ` +
          `${result.imported} imported, ${result.updated} updated (${result.status})`,
      );
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
