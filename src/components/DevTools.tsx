import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ActualAccount, AkahuAccount } from "../App";

interface ComputedPayee {
  payee: string;
  notes: string;
  merchantName: string | null;
  date: string;
  amount: number;
}

interface AugmentedTransaction {
  raw: Record<string, unknown>;
  pending: boolean;
  accountId: string;
  computed: ComputedPayee;
}

interface Props {
  akahuAccounts: AkahuAccount[];
  actualAccounts: ActualAccount[];
}

const ALL_ACCOUNTS = "__ALL__";

export function DevTools({ akahuAccounts, actualAccounts }: Props) {
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [loading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<AugmentedTransaction[]>([]);
  const [selected, setSelected] = useState<AugmentedTransaction | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteFromDate, setDeleteFromDate] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Keep ALL mutually exclusive with individual account selections
  const handleDeleteSelection = (next: string[]) => {
    const hadAll = deleteIds.includes(ALL_ACCOUNTS);
    const hasAll = next.includes(ALL_ACCOUNTS);
    if (hasAll && !hadAll) {
      setDeleteIds([ALL_ACCOUNTS]);
    } else if (hasAll && next.length > 1) {
      setDeleteIds(next.filter((v) => v !== ALL_ACCOUNTS));
    } else {
      setDeleteIds(next);
    }
  };

  const deleteSelectionLabel = () => {
    if (deleteIds.length === 0) return "Select account(s)…";
    if (deleteIds.includes(ALL_ACCOUNTS)) return "ALL accounts";
    const names = deleteIds.map((id) => actualAccounts.find((a) => a.id === id)?.name ?? id);
    return names.length <= 2 ? names.join(", ") : `${names.length} accounts`;
  };

  const deleteTransactions = async () => {
    const isAll = deleteIds.includes(ALL_ACCOUNTS);
    const resolvedIds = isAll ? actualAccounts.map((a) => a.id) : deleteIds;
    if (resolvedIds.length === 0) {
      toast.error("Select at least one account");
      return;
    }
    const targetLabel = isAll ? `ALL ${resolvedIds.length} accounts` : deleteSelectionLabel();
    const scopeLabel = deleteFromDate
      ? `Actual transactions dated ${deleteFromDate} or later`
      : "ALL Actual transactions";
    if (!window.confirm(`Delete ${scopeLabel} from ${targetLabel}?\n\nThis cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch("/api/dev/delete-actual-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountIds: resolvedIds,
          from: deleteFromDate || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const total = (data.results as { deleted: number }[]).reduce(
          (sum, r) => sum + r.deleted,
          0,
        );
        toast.success(`Deleted ${total} transaction(s) from ${data.results.length} account(s)`);
      } else {
        toast.error(data.error || "Failed to delete");
      }
    } catch {
      toast.error("Request failed");
    } finally {
      setDeleting(false);
    }
  };

  const akahuAccountName = (id: string) => akahuAccounts.find((a) => a.id === id)?.name ?? id;

  const akahuSelectionLabel = () => {
    if (accountIds.length === 0) return "Select account(s)…";
    const names = accountIds.map(akahuAccountName);
    return names.length <= 2 ? names.join(", ") : `${names.length} accounts`;
  };

  const fetchTransactions = async () => {
    if (accountIds.length === 0) {
      toast.error("Select at least one account");
      return;
    }
    setLoading(true);
    setTransactions([]);
    setSelected(null);
    try {
      const res = await fetch("/api/dev/akahu-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds, start: startDate }),
      });
      const data = await res.json();
      if (data.success) {
        setTransactions(data.transactions);
        toast.success(`Fetched ${data.count} transactions`);
      } else {
        toast.error(data.error || "Failed to fetch");
      }
    } catch {
      toast.error("Request failed");
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: number) => {
    const abs = Math.abs(amount);
    const str = `$${abs.toFixed(2)}`;
    return amount < 0 ? `-${str}` : str;
  };

  // Check if description differs from computed payee (indicates stripping worked or merchant was used)
  const payeeDiffers = (t: AugmentedTransaction) => {
    const desc = (t.raw as any).description ?? "";
    return desc !== t.computed.payee;
  };

  const multiAccount = new Set(transactions.map((t) => t.accountId)).size > 1;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle>Akahu Transaction Inspector</CardTitle>
          <CardDescription>
            Inspect raw transaction data and see how payee names will be computed on import
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label>Akahu Accounts</Label>
              <Select multiple value={accountIds} onValueChange={setAccountIds}>
                <SelectTrigger className="w-full">
                  <span className={accountIds.length ? "" : "text-muted-foreground"}>
                    {akahuSelectionLabel()}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {akahuAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.connection ? ` — ${a.connection}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:w-44">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                max={new Date().toISOString().split("T")[0]}
              />
            </div>
            <Button
              onClick={fetchTransactions}
              disabled={loading}
              className="w-full gap-2 sm:w-auto"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {loading ? "Fetching…" : "Fetch"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results: Table OR Detail */}
      {transactions.length > 0 && !selected && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Transactions
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({transactions.length})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* Mobile: compact tappable list */}
            <div className="max-h-[600px] overflow-y-auto sm:hidden">
              {transactions.map((t, i) => {
                const desc = (t.raw as any).description ?? "";
                const differs = payeeDiffers(t);
                return (
                  <button
                    key={i}
                    onClick={() => setSelected(t)}
                    className="flex w-full flex-col gap-1 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm">{desc}</span>
                      <span
                        className={`shrink-0 text-sm tabular-nums ${
                          t.computed.amount < 0 ? "text-red-400" : "text-green-400"
                        }`}
                      >
                        {formatAmount(t.computed.amount)}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="shrink-0">{t.computed.date}</span>
                      {t.pending ? (
                        <Badge
                          variant="outline"
                          className="h-4 shrink-0 px-1 text-[10px] border-yellow-500/50 text-yellow-500"
                        >
                          pending
                        </Badge>
                      ) : (
                        <>
                          <span className="truncate">→ {t.computed.payee}</span>
                          {differs && (
                            <Badge
                              variant={t.computed.merchantName ? "default" : "secondary"}
                              className="h-4 shrink-0 px-1 text-[10px]"
                            >
                              {t.computed.merchantName ? "merchant" : "cleaned"}
                            </Badge>
                          )}
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Desktop: full table */}
            <div className="hidden max-h-[600px] overflow-auto sm:block">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-4 py-2">Date</th>
                    {multiAccount && <th className="px-4 py-2">Account</th>}
                    <th className="px-4 py-2">Description</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Import Payee</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, i) => {
                    const desc = (t.raw as any).description ?? "";
                    const differs = payeeDiffers(t);
                    return (
                      <tr
                        key={i}
                        onClick={() => setSelected(t)}
                        className="cursor-pointer border-b transition-colors hover:bg-muted/50"
                      >
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                          {t.computed.date}
                        </td>
                        {multiAccount && (
                          <td className="whitespace-nowrap px-4 py-2">
                            {akahuAccountName(t.accountId)}
                          </td>
                        )}
                        <td className="px-4 py-2" title={desc}>
                          {desc}
                        </td>
                        <td className="px-4 py-2">
                          {t.pending && (
                            <Badge
                              variant="outline"
                              className="h-4 px-1 text-[10px] border-yellow-500/50 text-yellow-500"
                            >
                              pending
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {t.pending ? (
                            <span className="text-muted-foreground italic">no payee</span>
                          ) : (
                            <span className="flex items-center gap-1.5">
                              {t.computed.payee}
                              {differs && (
                                <Badge
                                  variant={t.computed.merchantName ? "default" : "secondary"}
                                  className="h-4 px-1 text-[10px]"
                                >
                                  {t.computed.merchantName ? "merchant" : "cleaned"}
                                </Badge>
                              )}
                              {!differs && (
                                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                                  raw
                                </Badge>
                              )}
                            </span>
                          )}
                        </td>
                        <td
                          className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
                            t.computed.amount < 0 ? "text-red-400" : "text-green-400"
                          }`}
                        >
                          {formatAmount(t.computed.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {selected && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                ← Back
              </Button>
              <CardTitle className="text-base">Transaction Detail</CardTitle>
              <span className="text-sm text-muted-foreground">
                {selected.computed.date} · {akahuAccountName(selected.accountId)}
              </span>
              {selected.pending && (
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[10px] border-yellow-500/50 text-yellow-500"
                >
                  pending
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
                  <span className="shrink-0 text-xs text-muted-foreground">Import Payee</span>
                  {selected.pending ? (
                    <span className="text-muted-foreground italic">no payee (pending)</span>
                  ) : (
                    <span className="min-w-0 break-words font-medium sm:text-right">
                      {selected.computed.payee}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
                  <span className="shrink-0 text-xs text-muted-foreground">Merchant Name</span>
                  <span
                    className={`min-w-0 break-words sm:text-right ${selected.computed.merchantName ? "" : "text-muted-foreground"}`}
                  >
                    {selected.computed.merchantName ?? "none"}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
                  <span className="shrink-0 text-xs text-muted-foreground">Description</span>
                  <span className="min-w-0 break-words sm:text-right">
                    {(selected.raw as any).description}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
                  <span className="shrink-0 text-xs text-muted-foreground">Notes</span>
                  <span className="min-w-0 break-words text-muted-foreground sm:text-right">
                    {selected.computed.notes}
                  </span>
                </div>
                {(selected.raw as any).meta && (
                  <div className="border-t pt-2 mt-2 space-y-1">
                    <span className="text-xs text-muted-foreground">Meta Fields</span>
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      {Object.entries((selected.raw as any).meta).map(([k, v]) => (
                        <div key={k} className="contents">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="min-w-0 break-words text-right">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Raw JSON</Label>
                <textarea
                  readOnly
                  value={JSON.stringify(selected.raw, null, 2)}
                  className="h-[300px] w-full rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Danger zone: wipe Actual transactions for faster full-sync test cycles */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete Actual Transactions</CardTitle>
          <CardDescription>
            Delete transactions from the selected Actual Budget account(s), optionally only those
            dated on or after the from date — leave it empty to delete all. Useful for re-running
            full sync tests from a clean slate. This cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label>Actual Accounts</Label>
              <Select multiple value={deleteIds} onValueChange={handleDeleteSelection}>
                <SelectTrigger className="w-full">
                  <span className={deleteIds.length ? "" : "text-muted-foreground"}>
                    {deleteSelectionLabel()}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ACCOUNTS}>ALL accounts</SelectItem>
                  {actualAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-44 space-y-1.5">
              <Label>From Date (optional)</Label>
              <Input
                type="date"
                value={deleteFromDate}
                onChange={(e) => setDeleteFromDate(e.target.value)}
              />
            </div>
            <Button
              variant="destructive"
              onClick={deleteTransactions}
              disabled={deleting || deleteIds.length === 0}
              className="gap-2"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
