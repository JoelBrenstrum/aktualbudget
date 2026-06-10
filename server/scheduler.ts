import cron from "node-cron";
import { loadConfig } from "./config.js";
import { runSync } from "./sync.js";

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

export function startSchedule(cronExpr: string): void {
  stopSchedule();

  if (!cron.validate(cronExpr)) {
    throw new Error(`Invalid cron expression: ${cronExpr}`);
  }

  console.log(`[scheduler] Starting sync schedule: ${cronExpr}`);

  scheduledTask = cron.schedule(cronExpr, async () => {
    try {
      const config = loadConfig();
      console.log(
        `[scheduler] Running scheduled sync (${config.schedule.syncDays} day lookback)...`,
      );
      const result = await runSync(config, config.schedule.syncDays, "scheduled");
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
