import cron from "node-cron";
import { loadConfig } from "./config.js";
import { runSync } from "./sync.js";

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

const INTERVAL_TO_CRON: Record<string, string> = {
  "every-1-hour": "0 * * * *",
  "every-6-hours": "0 */6 * * *",
  "every-12-hours": "0 */12 * * *",
  daily: "0 0 * * *",
};

export function startSchedule(interval: string): void {
  stopSchedule();

  const cronExpr = INTERVAL_TO_CRON[interval];
  if (!cronExpr) {
    throw new Error(`Unknown interval: ${interval}`);
  }

  console.log(`[scheduler] Starting sync schedule: ${interval} (${cronExpr})`);

  scheduledTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running scheduled sync...`);
    try {
      const config = loadConfig();
      const result = await runSync(config);
      const total = result.accounts.reduce((sum, a) => sum + a.imported, 0);
      console.log(`[scheduler] Sync complete. ${total} transactions imported.`);
    } catch (error) {
      console.error(`[scheduler] Sync failed:`, error);
    }
  });
}

export function stopSchedule(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[scheduler] Stopped sync schedule.");
  }
}

export function initScheduler(): void {
  const config = loadConfig();
  if (config.schedule.enabled && config.schedule.interval) {
    startSchedule(config.schedule.interval);
  }
}

export function getAvailableIntervals() {
  return Object.keys(INTERVAL_TO_CRON);
}
