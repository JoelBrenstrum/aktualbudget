import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig, saveConfig, type AppConfig } from "./config.js";
import { fetchActualAccounts, fetchAkahuAccounts, runSync, getSyncStatus } from "./sync.js";
import { initScheduler, startSchedule, stopSchedule } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve built frontend in production
const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));

// --- API Routes ---

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
  try {
    const result = await runSync(config, syncDays);
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

// SPA fallback
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);
  initScheduler();
});

// Prevent @actual-app/api internal errors from crashing the server
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception (suppressed):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection (suppressed):", reason);
});
