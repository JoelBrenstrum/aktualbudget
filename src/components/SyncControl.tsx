import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Loader2, RefreshCw, CheckCircle2, XCircle, Clock, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import type { AppConfig, SyncHistoryEntry } from "../App";

interface Props {
  config: AppConfig;
  onSave: (updates: Partial<AppConfig>) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "6 hours", cron: "0 */6 * * *" },
  { label: "12 hours", cron: "0 */12 * * *" },
  { label: "Daily", cron: "0 0 * * *" },
];

const SYNC_DAYS_OPTIONS: Record<string, string> = {
  "7": "7 days",
  "14": "14 days",
  "30": "30 days",
  "60": "60 days",
  "90": "90 days",
  "180": "180 days",
  "365": "1 year",
};

export function SyncControl({ config, onSave, onRefresh }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [syncDays, setSyncDays] = useState(String(config.schedule.syncDays ?? 30));
  const [scheduleEnabled, setScheduleEnabled] = useState(config.schedule.enabled);
  const [interval, setInterval] = useState(config.schedule.interval);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncDays: Number(syncDays) }),
      });
      const data = await res.json();
      if (data.success) {
        const totalImported = data.result.accounts.reduce(
          (sum: number, a: { imported: number }) => sum + a.imported,
          0,
        );
        toast.success(`Sync complete — ${totalImported} transactions imported`);
        await onRefresh();
      } else {
        toast.error(data.error || "Sync failed");
      }
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const updateSyncDays = async (days: string) => {
    setSyncDays(days);
    await onSave({
      schedule: { enabled: scheduleEnabled, interval, syncDays: Number(days) },
    });
  };

  const updateSchedule = async (enabled: boolean, newInterval?: string) => {
    const iv = newInterval || interval;
    setScheduleEnabled(enabled);
    if (newInterval) setInterval(newInterval);
    await onSave({
      schedule: { enabled, interval: iv, syncDays: Number(syncDays) },
    });
  };

  const hasMappings = config.accountMappings.length > 0;

  return (
    <div className="space-y-6">
      {/* Schedule */}
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>Configure sync frequency and lookback period</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Lookback Period</Label>
            <Select value={syncDays} onValueChange={(v) => v && updateSyncDays(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SYNC_DAYS_OPTIONS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              How far back to fetch transactions from Akahu
            </p>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-sync</Label>
              <p className="text-sm text-muted-foreground">
                {scheduleEnabled ? `Schedule: ${interval}` : "Disabled"}
              </p>
            </div>
            <Switch
              checked={scheduleEnabled}
              onCheckedChange={(checked) => updateSchedule(checked)}
              disabled={!hasMappings}
            />
          </div>
          <div className="space-y-2">
            <Label>Cron Expression</Label>
            <div className="flex gap-2">
              <Input
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                onBlur={() => updateSchedule(scheduleEnabled)}
                placeholder="* * * * *"
                className="font-mono"
                disabled={!hasMappings}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateSchedule(scheduleEnabled)}
                disabled={!hasMappings}
              >
                Apply
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((p) => (
                <Button
                  key={p.cron}
                  variant={interval === p.cron ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setInterval(p.cron);
                    updateSchedule(scheduleEnabled, p.cron);
                  }}
                  disabled={!hasMappings}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Manual Sync */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Manual Sync</CardTitle>
              <CardDescription>Trigger a sync for all mapped accounts</CardDescription>
            </div>
            <Badge variant="secondary" className="gap-1">
              <ArrowRightLeft className="h-3 w-3" />
              {config.accountMappings.length} mappings
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {!hasMappings ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
              No account mappings configured. Go to Account Mapping tab first.
            </div>
          ) : (
            <div className="space-y-3">
              <Button onClick={runSync} disabled={syncing} className="w-full gap-2" size="lg">
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {syncing ? "Syncing..." : "Sync Now"}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                Uses the {SYNC_DAYS_OPTIONS[syncDays] || `${syncDays} days`} lookback period
                configured above
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sync History */}
      {config.syncHistory.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Recent Syncs</CardTitle>
                <CardDescription>Per-account sync results</CardDescription>
              </div>
              <Button variant="ghost" size="icon" onClick={onRefresh}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {config.syncHistory.slice(0, 5).map((entry, i) => (
              <SyncHistoryCard key={i} entry={entry} isLatest={i === 0} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SyncHistoryCard({ entry, isLatest }: { entry: SyncHistoryEntry; isLatest: boolean }) {
  const allSuccess = entry.accounts.every((a) => a.status === "success");
  const totalImported = entry.accounts.reduce((s, a) => s + a.imported, 0);
  const totalUpdated = entry.accounts.reduce((s, a) => s + a.updated, 0);

  return (
    <div className={`rounded-lg border p-4 ${isLatest ? "border-foreground/20 bg-muted/30" : ""}`}>
      <div className="mb-3 flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          {allSuccess ? (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          ) : (
            <XCircle className="h-4 w-4 text-red-500" />
          )}
          <span className="font-medium">
            {totalImported} imported, {totalUpdated} updated
          </span>
          <Badge variant="outline" className="text-xs">
            {entry.trigger === "scheduled" ? "Scheduled" : "Manual"}
          </Badge>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" />
          {new Date(entry.timestamp).toLocaleString()}
        </div>
      </div>
      <div className="space-y-1">
        {entry.accounts.map((account, j) => (
          <div key={j} className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {account.akahuAccountName} → {account.actualAccountName}
            </span>
            <span>
              {account.status === "success" ? (
                <span className="text-foreground">
                  +{account.imported} / ~{account.updated}
                </span>
              ) : (
                <span className="text-red-500">{account.error || "Error"}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
