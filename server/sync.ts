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

function toLocalDateStr(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getMerchantName(t: Transaction): string | undefined {
  if ("merchant" in t && t.merchant?.name) {
    return t.merchant.name;
  }
  return undefined;
}

async function syncAccount(
  client: AkahuClient,
  userToken: string,
  mapping: AccountMapping,
  syncDays: number,
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

    // Transform to Actual Budget format
    // Match reference: merchant name as payee, raw description as notes
    const actualTransactions = allTransactions.map((t) => {
      const merchantName = getMerchantName(t);
      return {
        account: mapping.actualAccountId,
        date: toLocalDateStr(t.date),
        amount: Math.round(t.amount * 100),
        imported_id: t._id,
        payee_name: merchantName ?? t.description,
        notes: merchantName ? t.description : undefined,
        cleared: true,
      };
    });

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
      const result = await syncAccount(client, config.akahu.userToken, mapping, syncDays);
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
