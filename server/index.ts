import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import api from "@actual-app/api";
import {
  loadConfig,
  saveConfig,
  getDataDir,
  isLocked,
  hasSecrets,
  hasConfig,
  unlock,
  initializeSecrets,
  exportFullConfig,
  resetAll,
  type AppConfig,
} from "./config.js";
import { fetchActualAccounts, fetchAkahuAccounts, runSync, getSyncStatus } from "./sync.js";
import { initScheduler, startSchedule, stopSchedule } from "./scheduler.js";

// Tee console output to a log file in the data directory
const LOG_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = (...args: unknown[]) => {
  origLog(...args);
  logStream.write(`${new Date().toISOString()} [LOG] ${args.map(String).join(" ")}\n`);
};
console.error = (...args: unknown[]) => {
  origError(...args);
  logStream.write(`${new Date().toISOString()} [ERR] ${args.map(String).join(" ")}\n`);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3100;

app.use(cors());
app.use(express.json());

// Serve built frontend in production
const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));

// --- Unlock routes (no auth required) ---

app.get("/api/status", (_req, res) => {
  res.json({
    locked: isLocked(),
    configured: hasSecrets() || hasConfig(),
  });
});

app.post("/api/unlock", (req, res) => {
  const { password } = req.body as { password: string };
  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }

  try {
    if (hasSecrets() || hasConfig()) {
      unlock(password);
    } else {
      initializeSecrets(password);
    }

    // Start scheduler now that config is available
    try {
      initScheduler();
    } catch {
      // Scheduler init failure shouldn't block unlock
    }

    res.json({ success: true });
  } catch (error) {
    res.status(401).json({
      error: error instanceof Error ? error.message : "Unlock failed",
    });
  }
});

app.post("/api/reset", (_req, res) => {
  stopSchedule();
  resetAll();
  res.json({ success: true });
});

// --- Lock middleware (gates all other /api routes) ---

app.use("/api", (_req, res, next) => {
  if (isLocked()) {
    return res.status(423).json({ error: "locked" });
  }
  next();
});

// --- Protected API Routes ---

app.get("/api/config", (_req, res) => {
  const config = loadConfig();
  res.json(config);
});

app.post("/api/config", (req, res) => {
  const current = loadConfig();
  const body = req.body as Partial<AppConfig>;

  if (body.actual) {
    if (body.actual.serverUrl !== undefined) current.actual.serverUrl = body.actual.serverUrl;
    if (body.actual.syncId !== undefined) current.actual.syncId = body.actual.syncId;
    if (body.actual.password !== undefined) current.actual.password = body.actual.password;
    if (body.actual.encryptionPassword !== undefined)
      current.actual.encryptionPassword = body.actual.encryptionPassword;
  }
  if (body.akahu) {
    if (body.akahu.appToken !== undefined) current.akahu.appToken = body.akahu.appToken;
    if (body.akahu.userToken !== undefined) current.akahu.userToken = body.akahu.userToken;
  }
  if (body.accountMappings !== undefined) current.accountMappings = body.accountMappings;
  if (body.schedule !== undefined) {
    current.schedule = body.schedule;
    if (body.schedule.enabled) {
      startSchedule(body.schedule.interval);
    } else {
      stopSchedule();
    }
  }

  saveConfig(current);
  res.json({ success: true });
});

app.get("/api/export", (_req, res) => {
  const config = exportFullConfig();
  res.setHeader("Content-Disposition", "attachment; filename=aktualbudget-config.json");
  res.setHeader("Content-Type", "application/json");
  res.json(config);
});

app.post("/api/actual/test", async (req, res) => {
  const config = loadConfig();
  const body = req.body as Partial<AppConfig["actual"]>;

  // Use provided values or fall back to saved config
  const testConfig: AppConfig = {
    ...config,
    actual: {
      serverUrl: body?.serverUrl || config.actual.serverUrl,
      syncId: body?.syncId || config.actual.syncId,
      password: body?.password || config.actual.password,
      encryptionPassword: body?.encryptionPassword ?? config.actual.encryptionPassword,
    },
  };

  try {
    const accounts = await fetchActualAccounts(testConfig);
    const mapped = accounts
      .filter((a) => !a.closed)
      .map((a: { id: string; name: string; type?: string }) => ({
        id: a.id,
        name: a.name,
        type: a.type,
      }));
    // Cache for persistence across refreshes
    const current = loadConfig();
    current.cachedActualAccounts = mapped;
    // Remove mappings for accounts that no longer exist
    const accountIds = new Set(mapped.map((a: { id: string }) => a.id));
    const before = current.accountMappings.length;
    current.accountMappings = current.accountMappings.filter((m) =>
      accountIds.has(m.actualAccountId),
    );
    if (current.accountMappings.length < before) {
      console.log(`[config] Removed ${before - current.accountMappings.length} stale mapping(s)`);
    }
    saveConfig(current);
    res.json({ success: true, accounts: mapped });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/akahu/test", async (req, res) => {
  const config = loadConfig();
  const body = req.body as Partial<AppConfig["akahu"]>;

  const appToken = body?.appToken || config.akahu.appToken;
  const userToken = body?.userToken || config.akahu.userToken;

  try {
    const accounts = await fetchAkahuAccounts(appToken, userToken);
    const mapped = accounts
      .filter((a) => a.status === "ACTIVE")
      .map((a) => ({
        id: a._id,
        name: a.name,
        type: a.type,
        balance: a.balance?.current,
        connection: a.connection.name,
        formattedAccount: a.formatted_account,
      }));
    // Cache for persistence across refreshes
    const current = loadConfig();
    current.cachedAkahuAccounts = mapped;
    saveConfig(current);
    res.json({ success: true, accounts: mapped });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/sync/run", async (req, res) => {
  const config = loadConfig();
  const syncDays = req.body?.syncDays ?? 30;
  const cleanupManual = req.body?.cleanupManual ?? false;
  const refreshPayees = req.body?.refreshPayees ?? false;
  const startDate = req.body?.startDate as string | undefined;
  try {
    const result = await runSync(
      config,
      syncDays,
      "manual",
      cleanupManual,
      startDate,
      refreshPayees,
    );
    res.json({ success: true, result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/sync/status", (_req, res) => {
  const config = loadConfig();
  const status = getSyncStatus();
  res.json({
    ...status,
    schedule: config.schedule,
    history: config.syncHistory.slice(0, 10),
  });
});

app.post("/api/actual/create-account", async (req, res) => {
  const { name } = req.body as { name: string };

  const config = loadConfig();
  const dataDir = getDataDir();
  const serverURL = config.actual.serverUrl.trim();
  const normalizedUrl =
    serverURL && !/^https?:\/\//i.test(serverURL) ? `https://${serverURL}` : serverURL;

  try {
    await api.init({
      dataDir,
      serverURL: normalizedUrl,
      password: config.actual.password,
    });
    await api.downloadBudget(config.actual.syncId, {
      password: config.actual.encryptionPassword || undefined,
    });

    const newAccountId = await api.createAccount({ name, offbudget: false }, 0);

    const accounts = await api.getAccounts();
    await api.shutdown();

    // Update cached accounts
    const current = loadConfig();
    current.cachedActualAccounts = accounts
      .filter((a: { closed?: boolean }) => !a.closed)
      .map((a: { id: string; name: string }) => ({
        id: a.id,
        name: a.name,
      }));
    saveConfig(current);

    res.json({ success: true, accountId: newAccountId, accounts: current.cachedActualAccounts });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await api.shutdown();
    } catch {
      /* ignore */
    }
  }
});

// Dev: fetch raw Akahu transactions for inspection
app.post("/api/dev/akahu-transactions", async (req, res) => {
  const { accountId, start } = req.body as { accountId: string; start: string };
  if (!accountId || !start) {
    return res.status(400).json({ error: "accountId and start are required" });
  }
  const config = loadConfig();
  try {
    const { AkahuClient } = await import("akahu");
    const { getPayeeAndNotes, getMerchantName, toLocalDateStr } = await import("./sync.js");
    const client = new AkahuClient({ appToken: config.akahu.appToken });
    const allTransactions: unknown[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await client.accounts.listTransactions(config.akahu.userToken, accountId, {
        start,
        cursor: cursor ?? undefined,
      });
      allTransactions.push(...page.items);
      cursor = page.cursor.next;
    } while (cursor);

    // Fetch pending transactions too
    let pendingTransactions: unknown[] = [];
    try {
      pendingTransactions = await client.accounts.listPendingTransactions(
        config.akahu.userToken,
        accountId,
      );
    } catch {
      // Some accounts don't support pending
    }

    // Augment each transaction with the computed payee/notes
    const augment = (t: any, pending: boolean) => {
      const { payee, notes } = getPayeeAndNotes(t);
      return {
        raw: t,
        pending,
        computed: {
          payee,
          notes,
          merchantName: getMerchantName(t) ?? null,
          date: toLocalDateStr(t.date),
          amount: t.amount,
        },
      };
    };

    const augmented = [
      ...allTransactions.map((t: any) => augment(t, false)),
      ...pendingTransactions.map((t: any) => augment(t, true)),
    ].sort((a, b) => b.computed.date.localeCompare(a.computed.date));

    res.json({ success: true, count: augmented.length, transactions: augmented });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// SPA fallback
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);

  // Auto-unlock from env var so cron survives Docker restarts
  const envPassword = process.env.ENCRYPTION_PASSWORD;
  if (envPassword && isLocked() && (hasSecrets() || hasConfig())) {
    try {
      unlock(envPassword);
      console.log("[server] Auto-unlocked from ENCRYPTION_PASSWORD env var");
      try {
        initScheduler();
      } catch {
        // Scheduler init failure shouldn't block startup
      }
    } catch (err) {
      console.error("[server] Auto-unlock failed:", err instanceof Error ? err.message : err);
    }
  }
});

// Prevent @actual-app/api internal errors from crashing the server
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception (suppressed):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection (suppressed):", reason);
});
