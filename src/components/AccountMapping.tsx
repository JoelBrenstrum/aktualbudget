import { useState } from "react";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowRight, Plus, Trash2, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AppConfig, ActualAccount, AkahuAccount, AccountMappingItem } from "../App";

const CREATE_NEW_VALUE = "__create_new__";

interface Props {
  config: AppConfig;
  actualAccounts: ActualAccount[];
  akahuAccounts: AkahuAccount[];
  onSave: (updates: Partial<AppConfig>) => Promise<void>;
  onNext: () => void;
  onRefreshActual: (accounts: ActualAccount[]) => void;
}

export function AccountMapping({
  config,
  actualAccounts,
  akahuAccounts,
  onSave,
  onNext,
  onRefreshActual,
}: Props) {
  const [mappings, setMappings] = useState<AccountMappingItem[]>(config.accountMappings);
  const [savedMappings, setSavedMappings] = useState(config.accountMappings);
  const [saving, setSaving] = useState(false);

  const toggleEnabled = (index: number) => {
    const updated = [...mappings];
    updated[index] = {
      ...updated[index],
      enabled: mappings[index].enabled === false,
    };
    setMappings(updated);
  };

  const updateMapping = (index: number, field: "actual" | "akahu", id: string) => {
    const updated = [...mappings];
    if (field === "actual") {
      if (id === CREATE_NEW_VALUE) {
        updated[index] = {
          ...updated[index],
          actualAccountId: CREATE_NEW_VALUE,
          actualAccountName: "",
        };
      } else {
        const account = actualAccounts.find((a) => a.id === id);
        updated[index] = {
          ...updated[index],
          actualAccountId: id,
          actualAccountName: account?.name || "",
        };
      }
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

  const removeMapping = (index: number) => {
    setMappings(mappings.filter((_, i) => i !== index));
  };

  const addMapping = () => {
    setMappings([
      ...mappings,
      {
        actualAccountId: "",
        actualAccountName: "",
        akahuAccountId: "",
        akahuAccountName: "",
        enabled: true,
      },
    ]);
  };

  const columns: ColumnDef<AccountMappingItem>[] = [
    {
      id: "enabled",
      header: () => <span className="text-xs">Sync</span>,
      size: 60,
      cell: ({ row }) => (
        <Switch
          size="sm"
          checked={row.original.enabled !== false}
          onCheckedChange={() => toggleEnabled(row.index)}
        />
      ),
    },
    {
      id: "akahu",
      header: () => (
        <span className="flex items-center gap-1.5 text-xs">
          <img src="/akahu.svg" alt="Akahu" className="h-3.5 w-3.5" />
          Akahu Account
        </span>
      ),
      cell: ({ row }) => (
        <Select
          value={row.original.akahuAccountId}
          onValueChange={(v) => v && updateMapping(row.index, "akahu", v)}
        >
          <SelectTrigger className="w-full h-8 text-xs">
            <SelectValue placeholder="Select account...">
              {row.original.akahuAccountName || row.original.akahuAccountId}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {akahuAccounts
              .filter(
                (a) =>
                  a.id === row.original.akahuAccountId ||
                  !mappings.some((m, i) => i !== row.index && m.akahuAccountId === a.id),
              )
              .map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.connection ? (
                    <span className="ml-1 text-muted-foreground">— {a.connection}</span>
                  ) : null}
                  {a.balance != null ? (
                    <span className="ml-1 text-muted-foreground">${a.balance.toFixed(2)}</span>
                  ) : null}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: "arrow",
      header: () => null,
      size: 32,
      cell: () => <ArrowRight className="h-3 w-3 text-muted-foreground mx-auto" />,
    },
    {
      id: "actual",
      header: () => (
        <span className="flex items-center gap-1.5 text-xs">
          <img src="/actualbudget.png" alt="Actual Budget" className="h-3.5 w-3.5" />
          Actual Budget Account
        </span>
      ),
      cell: ({ row }) => (
        <Select
          value={row.original.actualAccountId}
          onValueChange={(v) => v && updateMapping(row.index, "actual", v)}
        >
          <SelectTrigger className="w-full h-8 text-xs">
            <SelectValue placeholder="Select account...">
              {row.original.actualAccountId === CREATE_NEW_VALUE ? (
                <span className="flex items-center gap-1 text-primary">
                  <Plus className="h-3 w-3" />
                  Create new account
                </span>
              ) : (
                row.original.actualAccountName || row.original.actualAccountId
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {row.original.akahuAccountId && (
              <SelectItem value={CREATE_NEW_VALUE} className="text-primary font-medium">
                <Plus className="mr-1 inline h-3 w-3" />
                Create new account
              </SelectItem>
            )}
            {actualAccounts
              .filter(
                (a) =>
                  a.id === row.original.actualAccountId ||
                  !mappings.some((m, i) => i !== row.index && m.actualAccountId === a.id),
              )
              .map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.type ? <span className="ml-1 text-muted-foreground">({a.type})</span> : null}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: "actions",
      header: () => null,
      size: 40,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => removeMapping(row.index)}
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ];

  const table = useReactTable({
    data: mappings,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const saveMappings = async () => {
    const complete = mappings.filter(
      (m) => (m.actualAccountId === CREATE_NEW_VALUE || m.actualAccountId) && m.akahuAccountId,
    );
    if (complete.length === 0) {
      toast.error("Add at least one complete mapping");
      return;
    }

    setSaving(true);
    try {
      const resolved = [...complete];
      for (let i = 0; i < resolved.length; i++) {
        if (resolved[i].actualAccountId !== CREATE_NEW_VALUE) continue;

        const akahuAccount = akahuAccounts.find((a) => a.id === resolved[i].akahuAccountId);
        if (!akahuAccount) continue;

        const accountName = akahuAccount.connection
          ? `${akahuAccount.name} (${akahuAccount.connection})`
          : akahuAccount.name;

        const res = await fetch("/api/actual/create-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: accountName,
            balance: akahuAccount.balance ?? 0,
            syncDays: config.schedule.syncDays ?? 30,
          }),
        });
        const data = await res.json();
        if (data.success) {
          resolved[i] = {
            ...resolved[i],
            actualAccountId: data.accountId,
            actualAccountName: accountName,
          };
          onRefreshActual(data.accounts);
          toast.success(`Created "${accountName}" in Actual Budget`);
        } else {
          toast.error(`Failed to create "${accountName}": ${data.error || "Unknown error"}`);
          setSaving(false);
          return;
        }
      }

      await onSave({ accountMappings: resolved });
      setMappings(resolved);
      setSavedMappings(resolved);
    } catch {
      toast.error("Failed to save mappings");
    } finally {
      setSaving(false);
    }
  };

  const saveAndContinue = async () => {
    await saveMappings();
    onNext();
  };

  const validMappings = mappings.filter(
    (m) => (m.actualAccountId === CREATE_NEW_VALUE || m.actualAccountId) && m.akahuAccountId,
  );
  const isDirty = JSON.stringify(mappings) !== JSON.stringify(savedMappings);
  const hasPendingCreations = mappings.some((m) => m.actualAccountId === CREATE_NEW_VALUE);
  const noAccounts = akahuAccounts.length === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Account Mapping</CardTitle>
              <CardDescription>
                Link your Akahu bank accounts to Actual Budget accounts
              </CardDescription>
            </div>
            <Badge variant="secondary" className="gap-1">
              <Link2 className="h-3 w-3" />
              {mappings.filter((m) => m.actualAccountId && m.akahuAccountId).length} linked
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {noAccounts && (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              <p>Test your Akahu connection first to load account lists.</p>
              <p className="mt-1 text-sm">
                Go to the Connections tab and click "Test Connection" for Akahu.
              </p>
            </div>
          )}

          {!noAccounts && (
            <div className="space-y-4">
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <TableHead
                            key={header.id}
                            style={{
                              width:
                                header.column.getSize() !== 150
                                  ? header.column.getSize()
                                  : undefined,
                            }}
                          >
                            {header.isPlaceholder
                              ? null
                              : flexRender(header.column.columnDef.header, header.getContext())}
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.length ? (
                      table.getRowModel().rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className={row.original.enabled === false ? "opacity-50" : ""}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={columns.length} className="h-16 text-center">
                          No mappings yet. Click "Add Mapping" to get started.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <Button variant="outline" onClick={addMapping} className="w-full gap-2">
                <Plus className="h-4 w-4" /> Add Mapping
              </Button>
              <p className="text-xs text-muted-foreground">
                New accounts created via "Create new account" are added as on-budget by default.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={saveMappings}
          disabled={saving || noAccounts || validMappings.length === 0 || !isDirty}
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {hasPendingCreations ? "Create & Save" : "Save"}
        </Button>
        <Button
          onClick={isDirty ? saveAndContinue : onNext}
          disabled={saving || noAccounts || validMappings.length === 0}
          className="gap-2"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {isDirty
            ? hasPendingCreations
              ? "Create, Save & Continue"
              : "Save & Continue to Sync"
            : "Continue to Sync"}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
