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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowRight, Plus, Trash2, Link2 } from "lucide-react";
import { toast } from "sonner";
import type { AppConfig, ActualAccount, AkahuAccount, AccountMappingItem } from "../App";

interface Props {
  config: AppConfig;
  actualAccounts: ActualAccount[];
  akahuAccounts: AkahuAccount[];
  onSave: (updates: Partial<AppConfig>) => Promise<void>;
  onNext: () => void;
}

export function AccountMapping({ config, actualAccounts, akahuAccounts, onSave, onNext }: Props) {
  const [mappings, setMappings] = useState<AccountMappingItem[]>(config.accountMappings);

  const [savedMappings, setSavedMappings] = useState(config.accountMappings);

  const addMapping = () => {
    setMappings([
      ...mappings,
      {
        actualAccountId: "",
        actualAccountName: "",
        akahuAccountId: "",
        akahuAccountName: "",
      },
    ]);
  };

  const removeMapping = (index: number) => {
    setMappings(mappings.filter((_, i) => i !== index));
  };

  const updateMapping = (index: number, field: "actual" | "akahu", id: string) => {
    const updated = [...mappings];
    if (field === "actual") {
      const account = actualAccounts.find((a) => a.id === id);
      updated[index] = {
        ...updated[index],
        actualAccountId: id,
        actualAccountName: account?.name || "",
      };
    } else {
      const account = akahuAccounts.find((a) => a.id === id);
      const displayName = account
        ? account.connection
          ? `${account.name} — ${account.connection}`
          : account.name
        : "";
      updated[index] = {
        ...updated[index],
        akahuAccountId: id,
        akahuAccountName: displayName,
      };
    }
    setMappings(updated);
  };

  const saveMappings = async () => {
    const valid = mappings.filter((m) => m.actualAccountId && m.akahuAccountId);
    if (valid.length === 0) {
      toast.error("Add at least one complete mapping");
      return;
    }
    await onSave({ accountMappings: valid });
    setMappings(valid);
    setSavedMappings(valid);
  };

  const saveAndContinue = async () => {
    await saveMappings();
    onNext();
  };

  const validMappings = mappings.filter((m) => m.actualAccountId && m.akahuAccountId);
  const isDirty = JSON.stringify(validMappings) !== JSON.stringify(savedMappings);

  const noAccounts = actualAccounts.length === 0 || akahuAccounts.length === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Account Mapping</CardTitle>
              <CardDescription>
                Link your Actual Budget accounts to their Akahu counterparts
              </CardDescription>
            </div>
            <Badge variant="secondary" className="gap-1">
              <Link2 className="h-3 w-3" />
              {mappings.filter((m) => m.actualAccountId && m.akahuAccountId).length} linked
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {noAccounts && (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              <p>Test both connections first to load account lists.</p>
              <p className="mt-1 text-sm">
                Go to the Connections tab and click "Test Connection" for both services.
              </p>
            </div>
          )}

          {!noAccounts && (
            <>
              {mappings.map((mapping, index) => (
                <div key={index}>
                  {index > 0 && <Separator className="mb-4" />}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        Actual Budget Account
                      </label>
                      <Select
                        value={mapping.actualAccountId}
                        onValueChange={(v) => v && updateMapping(index, "actual", v)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select account...">
                            {mapping.actualAccountName || mapping.actualAccountId}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {actualAccounts
                            .filter(
                              (a) =>
                                a.id === mapping.actualAccountId ||
                                !mappings.some((m, i) => i !== index && m.actualAccountId === a.id),
                            )
                            .map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                                {a.type ? (
                                  <span className="ml-1 text-muted-foreground">({a.type})</span>
                                ) : null}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block sm:mb-2.5" />

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        Akahu Account
                      </label>
                      <Select
                        value={mapping.akahuAccountId}
                        onValueChange={(v) => v && updateMapping(index, "akahu", v)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select account...">
                            {mapping.akahuAccountName || mapping.akahuAccountId}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {akahuAccounts
                            .filter(
                              (a) =>
                                a.id === mapping.akahuAccountId ||
                                !mappings.some((m, i) => i !== index && m.akahuAccountId === a.id),
                            )
                            .map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                                {a.connection ? (
                                  <span className="ml-1 text-muted-foreground">
                                    — {a.connection}
                                  </span>
                                ) : null}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeMapping(index)}
                      className="self-end shrink-0 text-muted-foreground hover:text-destructive sm:mb-0.5"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}

              <Button variant="outline" onClick={addMapping} className="w-full gap-2">
                <Plus className="h-4 w-4" /> Add Mapping
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={saveMappings}
          disabled={noAccounts || validMappings.length === 0 || !isDirty}
        >
          Save
        </Button>
        <Button
          onClick={isDirty ? saveAndContinue : onNext}
          disabled={noAccounts || validMappings.length === 0}
          className="gap-2"
        >
          {isDirty ? "Save & Continue to Sync" : "Continue to Sync"}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
