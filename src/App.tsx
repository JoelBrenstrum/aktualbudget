import { useState, useEffect, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { AccountMapping } from "./components/AccountMapping";
import { SyncControl } from "./components/SyncControl";

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
}

export interface AccountMappingItem {
  actualAccountId: string;
  actualAccountName: string;
  akahuAccountId: string;
  akahuAccountName: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  interval: string;
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

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [actualAccounts, setActualAccounts] = useState<ActualAccount[]>([]);
  const [akahuAccounts, setAkahuAccounts] = useState<AkahuAccount[]>([]);
  const [activeTab, setActiveTab] = useState("connections");

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      setConfig(data);
      if (data.cachedActualAccounts?.length) setActualAccounts(data.cachedActualAccounts);
      if (data.cachedAkahuAccounts?.length) setAkahuAccounts(data.cachedAkahuAccounts);
    } catch {
      toast.error("Failed to load configuration");
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const saveConfig = async (updates: Partial<AppConfig>) => {
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
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

  if (!config) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-8 flex items-center gap-4">
          <img src="/logo.png" alt="Aktual Budget Sync" className="h-12 w-12 rounded-xl" />
          <div>
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-white">
              Aktual Budget Sync
            </h1>
            <p className="mt-1 text-white/70">Sync your Akahu bank feeds into Actual Budget</p>
          </div>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 w-full justify-start">
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="accounts">Account Mapping</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
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
            />
          </TabsContent>

          <TabsContent value="sync">
            <SyncControl config={config} onSave={saveConfig} onRefresh={loadConfig} />
          </TabsContent>
        </Tabs>
      </div>
      <Toaster richColors position="bottom-right" />
    </div>
  );
}

export default App;
