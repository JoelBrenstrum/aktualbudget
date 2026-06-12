import fs from "fs";
import path from "path";
import { encrypt, decrypt } from "./crypto.js";

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
  enabled?: boolean;
}

export interface ScheduleConfig {
  enabled: boolean;
  interval: string; // "every-1-hour" | "every-6-hours" | "every-12-hours" | "daily"
  syncDays: number;
}

export interface BalanceValidation {
  akahuBalanceCents: number;
  actualBalanceCents: number;
  diffCents: number;
  matched: boolean;
  diagnosis: string[];
}

export interface AccountSyncResult {
  actualAccountName: string;
  akahuAccountName: string;
  imported: number;
  updated: number;
  deleted: number;
  status: "success" | "error";
  error?: string;
  balanceValidation?: BalanceValidation;
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
  balance?: number;
  connection?: string;
  formattedAccount?: string;
}

export interface SecretsConfig {
  actual: ActualConfig;
  akahu: AkahuConfig;
}

export interface PlainConfig {
  accountMappings: AccountMapping[];
  schedule: ScheduleConfig;
  syncHistory: SyncHistoryEntry[];
  cachedActualAccounts: CachedAccount[];
  cachedAkahuAccounts: CachedAccount[];
}

export interface AppConfig extends PlainConfig, SecretsConfig {}

const CONFIG_DIR = path.resolve(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SECRETS_PATH = path.join(CONFIG_DIR, "secrets.enc");
const BACKUP_PATH = path.join(CONFIG_DIR, "config.json.bak");

const DEFAULT_SECRETS: SecretsConfig = {
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
};

const DEFAULT_PLAIN: PlainConfig = {
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

// --- In-memory state ---
let cachedSecrets: SecretsConfig | null = null;
let encryptionPassword: string | null = null;

function ensureDataDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadPlainConfig(): PlainConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_PLAIN };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  return {
    accountMappings: parsed.accountMappings ?? DEFAULT_PLAIN.accountMappings,
    schedule: parsed.schedule ?? DEFAULT_PLAIN.schedule,
    syncHistory: parsed.syncHistory ?? DEFAULT_PLAIN.syncHistory,
    cachedActualAccounts: parsed.cachedActualAccounts ?? DEFAULT_PLAIN.cachedActualAccounts,
    cachedAkahuAccounts: parsed.cachedAkahuAccounts ?? DEFAULT_PLAIN.cachedAkahuAccounts,
  };
}

function savePlainConfig(plain: PlainConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(plain, null, 2), "utf-8");
}

function saveSecrets(secrets: SecretsConfig): void {
  if (!encryptionPassword) throw new Error("Cannot save secrets: not unlocked");
  ensureDataDir();
  const plaintext = JSON.stringify(secrets);
  const encrypted = encrypt(plaintext, encryptionPassword);
  fs.writeFileSync(SECRETS_PATH, encrypted, "utf-8");
}

// --- Migration ---

interface LegacyConfig extends PlainConfig {
  actual?: ActualConfig;
  akahu?: AkahuConfig;
}

function needsMigration(): boolean {
  if (!fs.existsSync(CONFIG_PATH) || fs.existsSync(SECRETS_PATH)) return false;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as LegacyConfig;
    return parsed.actual !== undefined || parsed.akahu !== undefined;
  } catch {
    return false;
  }
}

function migrate(password: string): SecretsConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");

  // Create backup before migration
  fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
  console.log(`[config] Backup created at ${BACKUP_PATH}`);

  const parsed = JSON.parse(raw) as LegacyConfig;

  // Extract secrets
  const secrets: SecretsConfig = {
    actual: parsed.actual ?? DEFAULT_SECRETS.actual,
    akahu: parsed.akahu ?? DEFAULT_SECRETS.akahu,
  };

  // Write clean plaintext config (without secrets)
  const plain: PlainConfig = {
    accountMappings: parsed.accountMappings ?? DEFAULT_PLAIN.accountMappings,
    schedule: parsed.schedule ?? DEFAULT_PLAIN.schedule,
    syncHistory: parsed.syncHistory ?? DEFAULT_PLAIN.syncHistory,
    cachedActualAccounts: parsed.cachedActualAccounts ?? DEFAULT_PLAIN.cachedActualAccounts,
    cachedAkahuAccounts: parsed.cachedAkahuAccounts ?? DEFAULT_PLAIN.cachedAkahuAccounts,
  };
  savePlainConfig(plain);

  // Encrypt and write secrets
  encryptionPassword = password;
  saveSecrets(secrets);

  console.log("[config] Migration complete: secrets extracted to secrets.enc");
  return secrets;
}

// --- Public API ---

export function isLocked(): boolean {
  return cachedSecrets === null && (hasSecrets() || needsMigration());
}

export function hasSecrets(): boolean {
  return fs.existsSync(SECRETS_PATH);
}

export function hasConfig(): boolean {
  return fs.existsSync(CONFIG_PATH) || fs.existsSync(SECRETS_PATH);
}

export function unlock(password: string): void {
  // Handle migration from legacy single-file config
  if (needsMigration()) {
    cachedSecrets = migrate(password);
    return;
  }

  if (!fs.existsSync(SECRETS_PATH)) {
    throw new Error("No secrets file found");
  }

  const encrypted = fs.readFileSync(SECRETS_PATH, "utf-8");
  const plaintext = decrypt(encrypted, password);
  cachedSecrets = JSON.parse(plaintext) as SecretsConfig;
  encryptionPassword = password;
  console.log("[config] Unlocked successfully");
}

export function initializeSecrets(password: string): void {
  encryptionPassword = password;
  cachedSecrets = { ...DEFAULT_SECRETS };
  saveSecrets(cachedSecrets);
  console.log("[config] Initialized new secrets file");
}

export function loadConfig(): AppConfig {
  if (!cachedSecrets) {
    throw new Error("Config is locked — call unlock() first");
  }
  const plain = loadPlainConfig();
  return { ...plain, ...cachedSecrets };
}

export function saveConfig(config: AppConfig): void {
  const plain: PlainConfig = {
    accountMappings: config.accountMappings,
    schedule: config.schedule,
    syncHistory: config.syncHistory,
    cachedActualAccounts: config.cachedActualAccounts,
    cachedAkahuAccounts: config.cachedAkahuAccounts,
  };
  const secrets: SecretsConfig = {
    actual: config.actual,
    akahu: config.akahu,
  };

  savePlainConfig(plain);
  saveSecrets(secrets);
  cachedSecrets = secrets;
}

export function addSyncHistoryEntry(entry: SyncHistoryEntry): void {
  const plain = loadPlainConfig();
  plain.syncHistory.unshift(entry);
  // Keep last 50 entries
  plain.syncHistory = plain.syncHistory.slice(0, 50);
  savePlainConfig(plain);
}

export function exportFullConfig(): AppConfig {
  return loadConfig();
}

export function resetAll(): void {
  cachedSecrets = null;
  encryptionPassword = null;
  if (fs.existsSync(SECRETS_PATH)) fs.unlinkSync(SECRETS_PATH);
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
  console.log("[config] Reset: all config files deleted");
}

export function getDataDir(): string {
  const dir = path.resolve(process.cwd(), "data", "actual");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
