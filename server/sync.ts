import api from "@actual-app/api";
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

interface AkahuTransaction {
  _id: string;
  date: string;
  description: string;
  amount: number;
  type: string;
  balance?: number;
  merchant?: { name?: string };
  category?: { name?: string };
  meta?: Record<string, unknown>;
}

interface AkahuPaginatedResponse {
  success: boolean;
  items: AkahuTransaction[];
  cursor?: { next?: string };
}

interface AkahuAccount {
  _id: string;
  name: string;
  type: string;
  formatted_account?: string;
  status: string;
  balance?: { available?: number; current?: number; currency?: string };
  connection?: { _id?: string; name?: string };
}

async function fetchAkahuTransactions(
  appToken: string,
  userToken: string,
  accountId: string,
  startDate: string,
): Promise<AkahuTransaction[]> {
  const allTransactions: AkahuTransaction[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ start: startDate });
    if (cursor) params.set("cursor", cursor);

    const url = `https://api.akahu.io/v1/accounts/${accountId}/transactions?${params}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        "X-Akahu-Id": appToken,
      },
    });

    if (!response.ok) {
      throw new Error(`Akahu API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AkahuPaginatedResponse;
    allTransactions.push(...data.items);
    cursor = data.cursor?.next ?? undefined;
  } while (cursor);

  return allTransactions;
}

export async function fetchAkahuAccounts(
  appToken: string,
  userToken: string,
): Promise<AkahuAccount[]> {
  const response = await fetch("https://api.akahu.io/v1/accounts", {
    headers: {
      Authorization: `Bearer ${userToken}`,
      "X-Akahu-Id": appToken,
    },
  });

  if (!response.ok) {
    throw new Error(`Akahu API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { success: boolean; items: AkahuAccount[] };
  if (!data.success) {
    throw new Error("Akahu API returned success: false");
  }
  return data.items;
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

async function syncAccount(
  mapping: AccountMapping,
  appToken: string,
  userToken: string,
  syncDays: number,
): Promise<AccountSyncResult> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - syncDays);
  const startDateStr = startDate.toISOString().split("T")[0];

  try {
    const transactions = await fetchAkahuTransactions(
      appToken,
      userToken,
      mapping.akahuAccountId,
      startDateStr,
    );

    // Transform to Actual Budget format
    // Actual uses integer amounts (cents), Akahu uses decimal
    const actualTransactions = transactions.map((t) => ({
      account: mapping.actualAccountId,
      date: t.date.split("T")[0],
      amount: Math.round(t.amount * 100),
      imported_id: t._id,
      payee_name: t.description,
      notes: t.merchant?.name && t.merchant.name !== t.description ? t.merchant.name : undefined,
      cleared: t.type !== "PENDING",
    }));

    const result = await api.importTransactions(mapping.actualAccountId, actualTransactions);

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

export async function runSync(config: AppConfig, syncDays = 30): Promise<SyncHistoryEntry> {
  if (isSyncing) {
    throw new Error("Sync is already running");
  }
  if (config.accountMappings.length === 0) {
    throw new Error("No account mappings configured");
  }

  isSyncing = true;
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

    const results: AccountSyncResult[] = [];
    for (const mapping of config.accountMappings) {
      const result = await syncAccount(
        mapping,
        config.akahu.appToken,
        config.akahu.userToken,
        syncDays,
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
