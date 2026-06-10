import fs from "fs";
import path from "path";

export interface ActualConfig {
  serverUrl: string;
  syncId: string;
  password: string;
  encryptionPassword: string;
}

export interface AkahuConfig {
  appToken: string;
  userToken: string;
}

export interface AccountMapping {
  actualAccountId: string;
  actualAccountName: string;
  akahuAccountId: string;
  akahuAccountName: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  interval: string; // "every-1-hour" | "every-6-hours" | "every-12-hours" | "daily"
  syncDays: number;
}

export interface AccountSyncResult {
  actualAccountName: string;
  akahuAccountName: string;
  imported: number;
  updated: number;
  status: "success" | "error";
  error?: string;
}

export interface SyncHistoryEntry {
  timestamp: string;
  trigger: "manual" | "scheduled";
  accounts: AccountSyncResult[];
}

export interface CachedAccount {
  id: string;
  name: string;
  type?: string;
  connection?: string;
  formattedAccount?: string;
}

export interface AppConfig {
  actual: ActualConfig;
  akahu: AkahuConfig;
  accountMappings: AccountMapping[];
  schedule: ScheduleConfig;
  syncHistory: SyncHistoryEntry[];
  cachedActualAccounts: CachedAccount[];
  cachedAkahuAccounts: CachedAccount[];
}

const CONFIG_DIR = path.resolve(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: AppConfig = {
  actual: {
    serverUrl: "",
    syncId: "",
    password: "",
    encryptionPassword: "",
  },
  akahu: {
    appToken: "",
    userToken: "",
  },
  accountMappings: [],
  schedule: {
    enabled: false,
    interval: "0 */6 * * *",
    syncDays: 30,
  },
  syncHistory: [],
  cachedActualAccounts: [],
  cachedAkahuAccounts: [],
};

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function saveConfig(config: AppConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function addSyncHistoryEntry(entry: SyncHistoryEntry): void {
  const config = loadConfig();
  config.syncHistory.unshift(entry);
  // Keep last 50 entries
  config.syncHistory = config.syncHistory.slice(0, 50);
  saveConfig(config);
}

export function getDataDir(): string {
  const dir = path.resolve(process.cwd(), "data", "actual");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
