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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import type { AkahuAccount } from "../App";

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
  computed: ComputedPayee;
}

interface Props {
  akahuAccounts: AkahuAccount[];
}

export function DevTools({ akahuAccounts }: Props) {
  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [loading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<AugmentedTransaction[]>([]);
  const [selected, setSelected] = useState<AugmentedTransaction | null>(null);

  const fetchTransactions = async () => {
    if (!accountId) {
      toast.error("Select an account");
      return;
    }
    setLoading(true);
    setTransactions([]);
    setSelected(null);
    try {
      const res = await fetch("/api/dev/akahu-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, start: startDate }),
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
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label>Akahu Account</Label>
              <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an account…" />
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
            <div className="w-44 space-y-1.5">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                max={new Date().toISOString().split("T")[0]}
              />
            </div>
            <Button onClick={fetchTransactions} disabled={loading} className="gap-2">
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
            <div className="max-h-[600px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-4 py-2">Date</th>
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
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                ← Back
              </Button>
              <CardTitle className="text-base">Transaction Detail</CardTitle>
              <span className="text-sm text-muted-foreground">{selected.computed.date}</span>
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
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Import Payee</span>
                  {selected.pending ? (
                    <span className="text-muted-foreground italic">no payee (pending)</span>
                  ) : (
                    <span className="font-medium">{selected.computed.payee}</span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Merchant Name</span>
                  <span className={selected.computed.merchantName ? "" : "text-muted-foreground"}>
                    {selected.computed.merchantName ?? "none"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Description</span>
                  <span className="max-w-[400px] truncate text-right">
                    {(selected.raw as any).description}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Notes</span>
                  <span className="max-w-[400px] truncate text-right text-muted-foreground">
                    {selected.computed.notes}
                  </span>
                </div>
                {(selected.raw as any).meta && (
                  <div className="border-t pt-2 mt-2 space-y-1">
                    <span className="text-xs text-muted-foreground">Meta Fields</span>
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      {Object.entries((selected.raw as any).meta).map(([k, v]) => (
                        <div key={k} className="contents">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="truncate text-right">{String(v)}</span>
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
    </div>
  );
}
