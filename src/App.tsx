import { useState, useEffect, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { AccountMapping } from "./components/AccountMapping";
import { SyncControl } from "./components/SyncControl";
import { UnlockDialog } from "./components/UnlockDialog";
import { DevTools } from "./components/DevTools";

export interface ActualAccount {
  id: string;
  name: string;
  type?: string;
}

export interface AkahuAccount {
  id: string;
  name: string;
  type?: string;
  connection?: string;
  formattedAccount?: string;
  balance?: number;
}

export interface AccountMappingItem {
  actualAccountId: string;
  actualAccountName: string;
  akahuAccountId: string;
  akahuAccountName: string;
  enabled?: boolean;
}

export interface ScheduleConfig {
  enabled: boolean;
  interval: string;
  syncDays: number;
}

export interface AccountSyncResult {
  actualAccountName: string;
  akahuAccountName: string;
  imported: number;
  updated: number;
  deleted: number;
  status: "success" | "error";
  error?: string;
}

export interface SyncHistoryEntry {
  timestamp: string;
  trigger?: "manual" | "scheduled";
  accounts: AccountSyncResult[];
}

export interface AppConfig {
  actual: {
    serverUrl: string;
    syncId: string;
    password: string;
    encryptionPassword: string;
  };
  akahu: {
    appToken: string;
    userToken: string;
  };
  accountMappings: AccountMappingItem[];
  schedule: ScheduleConfig;
  syncHistory: SyncHistoryEntry[];
}

interface ServerStatus {
  locked: boolean;
  configured: boolean;
}

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [actualAccounts, setActualAccounts] = useState<ActualAccount[]>([]);
  const [akahuAccounts, setAkahuAccounts] = useState<AkahuAccount[]>([]);
  const [activeTab, setActiveTab] = useState("connections");

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      const data = (await res.json()) as ServerStatus;
      setStatus(data);
      return data;
    } catch {
      toast.error("Cannot connect to server");
      return null;
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      if (res.status === 423) {
        setStatus({ locked: true, configured: true });
        setConfig(null);
        return;
      }
      const data = await res.json();
      setConfig(data);
      if (data.cachedActualAccounts?.length) setActualAccounts(data.cachedActualAccounts);
      if (data.cachedAkahuAccounts?.length) setAkahuAccounts(data.cachedAkahuAccounts);
    } catch {
      toast.error("Failed to load configuration");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleUnlocked = async () => {
    setStatus({ locked: false, configured: true });
    await loadConfig();
  };

  const saveConfig = async (updates: Partial<AppConfig>) => {
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.status === 423) {
        setStatus({ locked: true, configured: true });
        setConfig(null);
        toast.error("Session expired — please unlock again");
        return;
      }
      const data = await res.json();
      if (data.success) {
        // Update local config state so other tabs see changes immediately
        setConfig((prev) => (prev ? { ...prev, ...updates } : prev));
        toast.success("Settings saved");
      } else {
        toast.error("Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    }
  };

  const handleExport = async () => {
    try {
      const res = await fetch("/api/export");
      if (res.status === 423) {
        setStatus({ locked: true, configured: true });
        setConfig(null);
        return;
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "aktualbudget-config.json";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Config exported");
    } catch {
      toast.error("Export failed");
    }
  };

  // Still loading status
  if (!status) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Locked or not yet configured — show unlock dialog
  if (status.locked || !config) {
    return (
      <>
        <UnlockDialog configured={status.configured} onUnlocked={handleUnlocked} />
        <Toaster richColors position="bottom-right" />
      </>
    );
  }

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-8 flex items-center gap-4">
          <img src="/logo.png" alt="Aktual Budget Sync" className="h-12 w-12 rounded-xl" />
          <div className="flex-1">
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-white">
              Aktual Budget Sync
            </h1>
            <p className="mt-1 text-white/70">Sync your Akahu bank feeds into Actual Budget</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={handleExport}
            title="Export decrypted config"
          >
            <Download className="h-4 w-4" />
            Export
          </Button>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 w-full justify-start">
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="accounts">Account Mapping</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
            <TabsTrigger value="dev">Dev</TabsTrigger>
          </TabsList>

          <TabsContent value="connections">
            <ConnectionSettings
              config={config}
              actualAccounts={actualAccounts}
              akahuAccounts={akahuAccounts}
              onActualAccountsLoaded={setActualAccounts}
              onAkahuAccountsLoaded={setAkahuAccounts}
              onNext={() => setActiveTab("accounts")}
            />
          </TabsContent>

          <TabsContent value="accounts">
            <AccountMapping
              config={config}
              actualAccounts={actualAccounts}
              akahuAccounts={akahuAccounts}
              onSave={saveConfig}
              onNext={() => setActiveTab("sync")}
              onRefreshActual={setActualAccounts}
            />
          </TabsContent>

          <TabsContent value="sync">
            <SyncControl config={config} onSave={saveConfig} onRefresh={loadConfig} />
          </TabsContent>

          <TabsContent value="dev">
            <DevTools akahuAccounts={akahuAccounts} />
          </TabsContent>
        </Tabs>
      </div>
      <Toaster richColors position="bottom-right" />
    </div>
  );
}

export default App;
