import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import type { AppConfig, ActualAccount, AkahuAccount } from "../App";

interface Props {
  config: AppConfig;
  onSave: (updates: Partial<AppConfig>) => Promise<void>;
  onActualAccountsLoaded: (accounts: ActualAccount[]) => void;
  onAkahuAccountsLoaded: (accounts: AkahuAccount[]) => void;
  onNext: () => void;
}

export function ConnectionSettings({
  config,
  onSave,
  onActualAccountsLoaded,
  onAkahuAccountsLoaded,
  onNext,
}: Props) {
  // Actual Budget form state
  const [actualUrl, setActualUrl] = useState(config.actual.serverUrl);
  const [actualSyncId, setActualSyncId] = useState(config.actual.syncId);
  const [actualPassword, setActualPassword] = useState(config.actual.password);
  const [actualEncPassword, setActualEncPassword] = useState(
    config.actual.encryptionPassword
  );
  const [actualTesting, setActualTesting] = useState(false);
  const [actualStatus, setActualStatus] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [actualAccountCount, setActualAccountCount] = useState(0);

  // Akahu form state
  const [akahuAppToken, setAkahuAppToken] = useState(config.akahu.appToken);
  const [akahuUserToken, setAkahuUserToken] = useState(config.akahu.userToken);
  const [akahuTesting, setAkahuTesting] = useState(false);
  const [akahuStatus, setAkahuStatus] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [akahuAccountCount, setAkahuAccountCount] = useState(0);

  const testActual = async () => {
    setActualTesting(true);
    setActualStatus("idle");
    try {
      const res = await fetch("/api/actual/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverUrl: actualUrl,
          syncId: actualSyncId,
          password: actualPassword,
          encryptionPassword: actualEncPassword,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setActualStatus("success");
        setActualAccountCount(data.accounts.length);
        onActualAccountsLoaded(data.accounts);
        // Save credentials directly, bypassing parent
        fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actual: {
              serverUrl: actualUrl,
              syncId: actualSyncId,
              password: actualPassword,
              encryptionPassword: actualEncPassword,
            },
          }),
        });
        toast.success(`Connected — found ${data.accounts.length} accounts`);
      } else {
        setActualStatus("error");
        toast.error(data.error || "Connection failed");
      }
    } catch {
      setActualStatus("error");
      toast.error("Connection failed");
    } finally {
      setActualTesting(false);
    }
  };

  const testAkahu = async () => {
    setAkahuTesting(true);
    setAkahuStatus("idle");
    try {
      const res = await fetch("/api/akahu/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appToken: akahuAppToken,
          userToken: akahuUserToken,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAkahuStatus("success");
        setAkahuAccountCount(data.accounts.length);
        onAkahuAccountsLoaded(data.accounts);
        // Save credentials directly, bypassing parent
        fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            akahu: {
              appToken: akahuAppToken,
              userToken: akahuUserToken,
            },
          }),
        });
        toast.success(`Connected — found ${data.accounts.length} accounts`);
      } else {
        setAkahuStatus("error");
        toast.error(data.error || "Connection failed");
      }
    } catch {
      setAkahuStatus("error");
      toast.error("Connection failed");
    } finally {
      setAkahuTesting(false);
    }
  };

  const bothConnected = actualStatus === "success" && akahuStatus === "success";

  return (
    <div className="space-y-6" onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}>
      <div className="grid gap-6 md:grid-cols-2">
        {/* Actual Budget Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Actual Budget</CardTitle>
              {actualStatus === "success" && (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                  {actualAccountCount} accounts
                </Badge>
              )}
              {actualStatus === "error" && (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3 w-3" />
                  Failed
                </Badge>
              )}
            </div>
            <CardDescription>
              Connect to your self-hosted Actual Budget server
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="actual-url">Server URL</Label>
              <Input
                id="actual-url"
                placeholder="https://actual.example.com"
                value={actualUrl}
                onChange={(e) => setActualUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actual-sync-id">Sync ID</Label>
              <Input
                id="actual-sync-id"
                placeholder="Found in Settings → Show Advanced"
                value={actualSyncId}
                onChange={(e) => setActualSyncId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actual-password">Password</Label>
              <Input
                id="actual-password"
                type="password"
                placeholder="Server password"
                value={actualPassword}
                onChange={(e) => setActualPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actual-enc-password">
                Encryption Password{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="actual-enc-password"
                type="password"
                placeholder="Only if database is encrypted"
                value={actualEncPassword}
                onChange={(e) => setActualEncPassword(e.target.value)}
              />
            </div>
            <Button
              type="button"
              onClick={(e) => { e.preventDefault(); testActual(); }}
              disabled={actualTesting || !actualUrl || !actualSyncId || !actualPassword}
              className="w-full"
            >
              {actualTesting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Test Connection
            </Button>
          </CardContent>
        </Card>

        {/* Akahu Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Akahu</CardTitle>
              {akahuStatus === "success" && (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                  {akahuAccountCount} accounts
                </Badge>
              )}
              {akahuStatus === "error" && (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3 w-3" />
                  Failed
                </Badge>
              )}
            </div>
            <CardDescription>
              Connect to your Akahu open banking account
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="akahu-app-token">App Token</Label>
              <Input
                id="akahu-app-token"
                type="password"
                placeholder="app_token_..."
                value={akahuAppToken}
                onChange={(e) => setAkahuAppToken(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="akahu-user-token">User Token</Label>
              <Input
                id="akahu-user-token"
                type="password"
                placeholder="user_token_..."
                value={akahuUserToken}
                onChange={(e) => setAkahuUserToken(e.target.value)}
              />
            </div>
            <Button
              type="button"
              onClick={(e) => { e.preventDefault(); testAkahu(); }}
              disabled={akahuTesting || !akahuAppToken || !akahuUserToken}
              className="w-full"
            >
              {akahuTesting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Test Connection
            </Button>
          </CardContent>
        </Card>
      </div>

      {bothConnected && (
        <div className="flex justify-end">
          <Button onClick={onNext} className="gap-2">
            Map Accounts <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
