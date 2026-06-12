import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, KeyRound, AlertTriangle } from "lucide-react";

interface Props {
  configured: boolean;
  onUnlocked: () => void;
}

export function UnlockDialog({ configured, onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const isSetup = !configured;
  const canSubmit = isSetup
    ? password.length > 0 && password === confirmPassword
    : password.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onUnlocked();
      } else {
        setError(data.error || "Unlock failed");
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setShowReset(false);
        setPassword("");
        setConfirmPassword("");
        setError("");
        // Reload to get fresh status (now unconfigured)
        window.location.reload();
      } else {
        setError("Reset failed");
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <div className="mb-8 flex items-center gap-3">
          <img src="/logo.png" alt="Aktual Budget Sync" className="h-10 w-10 rounded-xl" />
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-white">
            Aktual Budget Sync
          </h1>
        </div>

        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              {isSetup ? (
                <KeyRound className="h-6 w-6 text-muted-foreground" />
              ) : (
                <Lock className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <CardTitle>{isSetup ? "Set Encryption Password" : "Unlock"}</CardTitle>
            <CardDescription>
              {isSetup
                ? "Choose a password to encrypt your credentials at rest"
                : "Enter your password to decrypt the configuration"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="unlock-password">Password</Label>
                <Input
                  id="unlock-password"
                  type="password"
                  placeholder={isSetup ? "Choose a password" : "Enter your password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  autoFocus
                />
              </div>

              {isSetup && (
                <div className="space-y-2">
                  <Label htmlFor="unlock-confirm">Confirm Password</Label>
                  <Input
                    id="unlock-confirm"
                    type="password"
                    placeholder="Confirm your password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      setError("");
                    }}
                  />
                  {confirmPassword && password !== confirmPassword && (
                    <p className="text-xs text-destructive">Passwords do not match</p>
                  )}
                </div>
              )}

              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" disabled={!canSubmit || loading} className="w-full">
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isSetup ? "Set Password & Continue" : "Unlock"}
              </Button>

              {configured && !showReset && (
                <button
                  type="button"
                  onClick={() => setShowReset(true)}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Forgot password? Start from scratch
                </button>
              )}

              {showReset && (
                <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      This will delete all configuration including saved credentials. You'll need to
                      re-enter everything.
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="flex-1"
                      onClick={handleReset}
                      disabled={resetting}
                    >
                      {resetting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Delete & Reset
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setShowReset(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
