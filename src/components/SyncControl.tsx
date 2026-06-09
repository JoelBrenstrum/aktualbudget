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

const INTERVAL_LABELS: Record<string, string> = {
  "every-1-hour": "Every hour",
  "every-6-hours": "Every 6 hours",
  "every-12-hours": "Every 12 hours",
  daily: "Daily",
};

export function SyncControl({ config, onSave, onRefresh }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(config.schedule.enabled);
  const [interval, setInterval] = useState(config.schedule.interval);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
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

  const updateSchedule = async (enabled: boolean, newInterval?: string) => {
    const iv = newInterval || interval;
    setScheduleEnabled(enabled);
    if (newInterval) setInterval(newInterval);
    await onSave({
      schedule: { enabled, interval: iv },
    });
  };

  const hasMappings = config.accountMappings.length > 0;

  return (
    <div className="space-y-6">
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
            <Button onClick={runSync} disabled={syncing} className="w-full gap-2" size="lg">
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {syncing ? "Syncing..." : "Sync Now"}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Schedule */}
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>Automatically sync on a recurring schedule</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-sync</Label>
              <p className="text-sm text-muted-foreground">
                {scheduleEnabled ? `Running ${INTERVAL_LABELS[interval] || interval}` : "Disabled"}
              </p>
            </div>
            <Switch
              checked={scheduleEnabled}
              onCheckedChange={(checked) => updateSchedule(checked)}
              disabled={!hasMappings}
            />
          </div>
          <Separator />
          <div className="space-y-1.5">
            <Label>Frequency</Label>
            <Select
              value={interval}
              onValueChange={(v) => v && updateSchedule(scheduleEnabled, v)}
              disabled={!hasMappings}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(INTERVAL_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Sync History */}
      {config.syncHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Syncs</CardTitle>
            <CardDescription>Per-account sync results</CardDescription>
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
