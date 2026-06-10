import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, ArrowRight, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import type { AppConfig, ActualAccount, AkahuAccount } from "../App";

interface Props {
  config: AppConfig;
  actualAccounts: ActualAccount[];
  akahuAccounts: AkahuAccount[];
  onActualAccountsLoaded: (accounts: ActualAccount[]) => void;
  onAkahuAccountsLoaded: (accounts: AkahuAccount[]) => void;
  onNext: () => void;
}

export function ConnectionSettings({
  config,
  actualAccounts,
  akahuAccounts,
  onActualAccountsLoaded,
  onAkahuAccountsLoaded,
  onNext,
}: Props) {
  // Actual Budget form state
  const [actualUrl, setActualUrl] = useState(config.actual.serverUrl);
  const [actualSyncId, setActualSyncId] = useState(config.actual.syncId);
  const [actualPassword, setActualPassword] = useState(config.actual.password);
  const [actualEncPassword, setActualEncPassword] = useState(config.actual.encryptionPassword);
  const [actualTesting, setActualTesting] = useState(false);
  const [actualStatus, setActualStatus] = useState<"idle" | "success" | "error">(
    actualAccounts.length > 0 ? "success" : "idle",
  );
  const [actualAccountCount, setActualAccountCount] = useState(actualAccounts.length);

  // Akahu form state
  const [akahuAppToken, setAkahuAppToken] = useState(config.akahu.appToken);
  const [akahuUserToken, setAkahuUserToken] = useState(config.akahu.userToken);
  const [akahuTesting, setAkahuTesting] = useState(false);
  const [akahuStatus, setAkahuStatus] = useState<"idle" | "success" | "error">(
    akahuAccounts.length > 0 ? "success" : "idle",
  );
  const [akahuAccountCount, setAkahuAccountCount] = useState(akahuAccounts.length);

  const [showSecrets, setShowSecrets] = useState(false);

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
    <div
      className="space-y-6"
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
    >
      <div className="grid gap-6 md:grid-cols-2">
        {/* Akahu Card (Left) */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <img src="/akahu.svg" alt="Akahu" className="h-5 w-5" />
                Akahu
              </CardTitle>
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
            <CardDescription>Connect to your Akahu open banking account</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="akahu-app-token">App Token</Label>
              <div className="relative">
                <Input
                  id="akahu-app-token"
                  type={showSecrets ? "text" : "password"}
                  placeholder="app_token_..."
                  value={akahuAppToken}
                  onChange={(e) => setAkahuAppToken(e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSecrets(!showSecrets)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="akahu-user-token">User Token</Label>
              <div className="relative">
                <Input
                  id="akahu-user-token"
                  type={showSecrets ? "text" : "password"}
                  placeholder="user_token_..."
                  value={akahuUserToken}
                  onChange={(e) => setAkahuUserToken(e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSecrets(!showSecrets)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <Button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                testAkahu();
              }}
              disabled={akahuTesting || !akahuAppToken || !akahuUserToken}
              className="w-full"
            >
              {akahuTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test Connection
            </Button>
          </CardContent>
        </Card>

        {/* Actual Budget Card (Right) */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <img src="/actualbudget.png" alt="Actual Budget" className="h-5 w-5" />
                Actual Budget
              </CardTitle>
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
            <CardDescription>Connect to your self-hosted Actual Budget server</CardDescription>
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
              <div className="relative">
                <Input
                  id="actual-password"
                  type={showSecrets ? "text" : "password"}
                  placeholder="Server password"
                  value={actualPassword}
                  onChange={(e) => setActualPassword(e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSecrets(!showSecrets)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="actual-enc-password">
                Encryption Password <span className="text-muted-foreground">(optional)</span>
              </Label>
              <div className="relative">
                <Input
                  id="actual-enc-password"
                  type={showSecrets ? "text" : "password"}
                  placeholder="Only if database is encrypted"
                  value={actualEncPassword}
                  onChange={(e) => setActualEncPassword(e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSecrets(!showSecrets)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <Button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                testActual();
              }}
              disabled={actualTesting || !actualUrl || !actualSyncId || !actualPassword}
              className="w-full"
            >
              {actualTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test Connection
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!bothConnected} className="gap-2">
          Map Accounts <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
