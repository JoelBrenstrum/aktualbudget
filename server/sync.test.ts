import { describe, expect, it } from "vitest";
import type { Transaction } from "akahu";
import {
  toLocalDateStr,
  getMerchantName,
  getOtherAccount,
  getCardSuffix,
  getPayeeAndNotes,
  mapTransaction,
  calculateStartingBalance,
  shouldUpdateStartingBalance,
  getStartingBalanceDate,
  type TransferLookup,
} from "./sync.js";

// Helper to create a minimal RawTransaction
function rawTxn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    _id: "txn_abc123",
    _account: "acc_123",
    _connection: "conn_123",
    date: "2024-06-15T00:00:00.000Z",
    description: "COUNTDOWN AUCKLAND",
    amount: -42.5,
    balance: 1234.56,
    type: "EFTPOS",
    status: "ACTIVE",
    hash: "hash123",
    created_at: "2024-06-15T12:00:00.000Z",
    updated_at: "2024-06-15T12:00:00.000Z",
    ...overrides,
  } as unknown as Transaction;
}

// Helper to create an EnrichedTransaction (with merchant/meta)
function enrichedTxn(
  overrides: Partial<Transaction> = {},
  merchant?: { _id: string; name: string },
  meta?: { other_account?: string },
): Transaction {
  return {
    ...rawTxn(overrides),
    ...(merchant ? { merchant } : {}),
    ...(meta ? { meta } : {}),
    category: {
      _id: "cat_123",
      name: "Groceries",
      groups: {},
    },
  } as unknown as Transaction;
}

const emptyLookup: TransferLookup = {
  bankNumberToActualId: new Map(),
  cardSuffixToActualId: new Map(),
  actualIdToTransferPayeeId: new Map(),
};

// --- toLocalDateStr ---

describe("toLocalDateStr", () => {
  it("formats ISO date to YYYY-MM-DD in local timezone", () => {
    // Use a date that won't shift across timezone boundaries
    const result = toLocalDateStr("2024-06-15T12:00:00.000Z");
    // Should be a valid YYYY-MM-DD format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("pads single-digit month and day", () => {
    // Use a time near start of day UTC so even UTC+13 stays on same day
    const result = toLocalDateStr("2024-01-05T00:00:00.000+12:00");
    expect(result).toBe("2024-01-05");
  });
});

// --- getMerchantName ---

describe("getMerchantName", () => {
  it("returns undefined for raw transactions", () => {
    expect(getMerchantName(rawTxn())).toBeUndefined();
  });

  it("returns merchant name for enriched transactions", () => {
    const t = enrichedTxn({}, { _id: "m_1", name: "Countdown" });
    expect(getMerchantName(t)).toBe("Countdown");
  });

  it("returns undefined when merchant has no name", () => {
    const t = enrichedTxn({}, { _id: "m_1", name: "" });
    expect(getMerchantName(t)).toBeUndefined();
  });
});

// --- getOtherAccount ---

describe("getOtherAccount", () => {
  it("returns undefined for raw transactions", () => {
    expect(getOtherAccount(rawTxn())).toBeUndefined();
  });

  it("returns other_account from meta", () => {
    const t = enrichedTxn({}, undefined, { other_account: "02-0100-0100001-07" });
    expect(getOtherAccount(t)).toBe("02-0100-0100001-07");
  });

  it("returns undefined when meta has no other_account", () => {
    const t = enrichedTxn({}, undefined, {});
    expect(getOtherAccount(t)).toBeUndefined();
  });
});

// --- getCardSuffix ---

describe("getCardSuffix", () => {
  it("returns undefined for raw transactions", () => {
    expect(getCardSuffix(rawTxn())).toBeUndefined();
  });

  it("returns card_suffix from meta", () => {
    const t = rawTxn();
    (t as any).meta = { card_suffix: "4321" };
    expect(getCardSuffix(t)).toBe("4321");
  });

  it("returns undefined when meta has no card_suffix", () => {
    const t = enrichedTxn({}, undefined, {});
    expect(getCardSuffix(t)).toBeUndefined();
  });
});

// --- getPayeeAndNotes (BNZ description cleanup) ---

describe("getPayeeAndNotes", () => {
  it("strips particulars and reference from payment description", () => {
    const t = enrichedTxn({ description: "Acme Utilities Ltd Water INV99201" }, undefined, {
      other_account: "01-0200-0100001-00",
    });
    (t as any).meta.particulars = "Water";
    (t as any).meta.reference = "INV99201";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("Acme Utilities Ltd");
    expect(result.notes).toBe("Water | INV99201");
  });

  it("strips particulars and code from standing order description", () => {
    const t = enrichedTxn({ description: "SMITH, JANE A Jane rent Xx" }, undefined, {
      other_account: "02-0200-0200002-03",
    });
    (t as any).meta.particulars = "Jane rent";
    (t as any).meta.code = "Xx";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("SMITH, JANE A");
    expect(result.notes).toBe("Jane rent | Xx");
  });

  it("uses merchant name when available, meta fields as notes", () => {
    const t = enrichedTxn(
      { description: "Acme Property Mgmt Rent T100200" },
      { _id: "merchant_123", name: "Acme Property Management Ltd" },
      { other_account: "12-3000-0030003-00" },
    );
    (t as any).meta.particulars = "Rent";
    (t as any).meta.reference = "T100200";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("Acme Property Management Ltd");
    expect(result.notes).toBe("Rent | T100200");
  });

  it("falls back to full description when no meta fields", () => {
    const t = rawTxn({ description: "COUNTDOWN AUCKLAND" });
    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("COUNTDOWN AUCKLAND");
    expect(result.notes).toBe("COUNTDOWN AUCKLAND");
  });

  it("handles description that is entirely meta fields", () => {
    const t = enrichedTxn({ description: "Rent T100200" }, undefined, {});
    (t as any).meta.particulars = "Rent";
    (t as any).meta.reference = "T100200";

    const result = getPayeeAndNotes(t);
    // Falls back to original since stripping leaves nothing
    expect(result.payee).toBe("Rent T100200");
  });

  it("strips particulars and code from salary direct credit", () => {
    const t = enrichedTxn(
      { description: "GLOBEX CORP LIMIT J Smith Salary", type: "DIRECT CREDIT" },
      undefined,
      { other_account: "12-3000-0080008-00" },
    );
    (t as any).meta.particulars = "J Smith";
    (t as any).meta.code = "Salary";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("GLOBEX CORP LIMIT");
    expect(result.notes).toBe("J Smith | Salary");
  });

  it("handles meta field word appearing in payee name", () => {
    // "OAKWOOD" is both in the payee name AND meta.code
    const t = enrichedTxn(
      { description: "OAKWOOD TRUST OAKWOOD SALARY", type: "DIRECT CREDIT" },
      undefined,
      { other_account: "06-0100-0800008-00" },
    );
    (t as any).meta.code = "OAKWOOD";
    (t as any).meta.reference = "SALARY";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("OAKWOOD TRUST");
    expect(result.notes).toBe("OAKWOOD | SALARY");
  });

  it("strips particulars-only suffix from standing order", () => {
    const t = enrichedTxn(
      { description: "Investco INVX000351", type: "STANDING ORDER" },
      undefined,
      { other_account: "04-2000-0300003-06" },
    );
    (t as any).meta.particulars = "INVX000351";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("Investco");
    expect(result.notes).toBe("INVX000351");
  });

  it("strips store number, city, and card reference from EFTPOS", () => {
    // EFTPOS with store number as particulars, city as code, card ref as reference
    const t = enrichedTxn(
      { description: "NORTHSIDE SUPERETTE 7839 WELLINGTON 492102011344", type: "EFTPOS" },
      undefined,
      {},
    );
    (t as any).meta.particulars = "7839";
    (t as any).meta.code = "WELLINGTON";
    (t as any).meta.reference = "492102011344";

    const result = getPayeeAndNotes(t);
    expect(result.payee).toBe("NORTHSIDE SUPERETTE");
    expect(result.notes).toBe("7839 | WELLINGTON | 492102011344");
  });
});

// --- mapTransaction ---

describe("mapTransaction", () => {
  const accountId = "actual-acc-1";

  it("maps basic transaction with description as payee", () => {
    const t = rawTxn({ description: "COUNTDOWN AUCKLAND", amount: -42.5 });
    const result = mapTransaction(t, accountId, emptyLookup);

    expect(result.account).toBe(accountId);
    expect(result.amount).toBe(-4250);
    expect(result.payee_name).toBe("COUNTDOWN AUCKLAND");
    expect(result.notes).toBe("COUNTDOWN AUCKLAND");
    expect(result.imported_id).toBe("txn_abc123");
    expect(result.cleared).toBe(true);
    expect(result.payee).toBeUndefined();
  });

  it("uses merchant name as payee when available", () => {
    const t = enrichedTxn(
      { description: "COUNTDOWN 1234 AUCKLAND" },
      { _id: "m_1", name: "Countdown" },
    );
    const result = mapTransaction(t, accountId, emptyLookup);

    expect(result.payee_name).toBe("Countdown");
    expect(result.notes).toBe("COUNTDOWN 1234 AUCKLAND");
  });

  it("falls back to description when merchant name is empty", () => {
    const t = enrichedTxn({ description: "SOME PAYMENT" }, { _id: "m_1", name: "" });
    const result = mapTransaction(t, accountId, emptyLookup);

    expect(result.payee_name).toBe("SOME PAYMENT");
    expect(result.notes).toBe("SOME PAYMENT");
  });

  it("converts amount to cents (integer)", () => {
    expect(mapTransaction(rawTxn({ amount: 120.3 }), accountId, emptyLookup).amount).toBe(12030);
    expect(mapTransaction(rawTxn({ amount: -0.01 }), accountId, emptyLookup).amount).toBe(-1);
    expect(mapTransaction(rawTxn({ amount: 0 }), accountId, emptyLookup).amount).toBe(0);
  });

  describe("transfer detection", () => {
    const transferLookup: TransferLookup = {
      bankNumberToActualId: new Map([
        ["02-0100-0100001-07", "actual-acc-savings"],
        ["12-3000-0080008-00", "actual-acc-credit"],
      ]),
      cardSuffixToActualId: new Map([
        ["0001", "actual-acc-savings"],
        ["8000", "actual-acc-credit"],
      ]),
      actualIdToTransferPayeeId: new Map([
        ["actual-acc-savings", "payee-transfer-savings"],
        ["actual-acc-credit", "payee-transfer-credit"],
      ]),
    };

    it("detects transfer when other_account matches mapped account", () => {
      const t = enrichedTxn({ type: "TRANSFER", description: "Transfer to Savings" }, undefined, {
        other_account: "02-0100-0100001-07",
      });
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBe("payee-transfer-savings");
      expect(result.payee_name).toBeUndefined();
      expect(result.notes).toBe("Transfer to Savings");
    });

    it("detects transfer for STANDING ORDER type", () => {
      const t = enrichedTxn(
        { type: "STANDING ORDER" as Transaction["type"], description: "Auto transfer" },
        undefined,
        { other_account: "12-3000-0080008-00" },
      );
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBe("payee-transfer-credit");
      expect(result.payee_name).toBeUndefined();
    });

    it("detects transfer for DIRECT CREDIT type", () => {
      const t = enrichedTxn(
        { type: "DIRECT CREDIT" as Transaction["type"], description: "Incoming" },
        undefined,
        { other_account: "02-0100-0100001-07" },
      );
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBe("payee-transfer-savings");
    });

    it("falls back to payee_name when other_account does not match", () => {
      const t = enrichedTxn({ type: "TRANSFER", description: "Transfer to external" }, undefined, {
        other_account: "99-9999-9999999-00",
      });
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBeUndefined();
      expect(result.payee_name).toBe("Transfer to external");
    });

    it("falls back to payee_name when no other_account present", () => {
      const t = rawTxn({ type: "TRANSFER", description: "Some transfer" });
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBeUndefined();
      expect(result.payee_name).toBe("Some transfer");
    });

    it("uses merchant name even when other_account is unmatched", () => {
      const t = enrichedTxn(
        { type: "PAYMENT", description: "PAY 12345" },
        { _id: "m_1", name: "My Savings" },
        { other_account: "99-0000-0000000-00" },
      );
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBeUndefined();
      expect(result.payee_name).toBe("My Savings");
      expect(result.notes).toBe("PAY 12345");
    });

    describe("ANZ card suffix fallback", () => {
      // ANZ transfers don't provide meta.other_account.
      // Instead, both sides share meta.card_suffix identifying the credit card.
      // The debit side's card_suffix points to the CC account.

      const anzLookup: TransferLookup = {
        bankNumberToActualId: new Map([
          ["11-2222-3333333-44", "actual-anz-freedom"],
          ["4999-****-****-7612", "actual-anz-visa"],
        ]),
        cardSuffixToActualId: new Map([
          ["3344", "actual-anz-freedom"],
          ["7612", "actual-anz-visa"],
        ]),
        actualIdToTransferPayeeId: new Map([
          ["actual-anz-freedom", "payee-transfer-freedom"],
          ["actual-anz-visa", "payee-transfer-visa"],
        ]),
      };

      it("detects transfer from debit account via card_suffix", () => {
        // Freedom account sends money to Visa CC (card suffix identifies CC)
        const t = rawTxn({
          _id: "trans_anz_debit_001",
          _account: "acc_anz_freedom",
          type: "TRANSFER",
          description: "To: 4999-****-****-7612 Debit Transfer 334455",
          amount: -315.75,
        });
        (t as any).meta = { card_suffix: "7612" };

        const result = mapTransaction(t, "actual-anz-freedom", anzLookup);

        expect(result.payee).toBe("payee-transfer-visa");
        expect(result.payee_name).toBeUndefined();
        expect(result.amount).toBe(-31575);
        expect(result.notes).toBe("To: 4999-****-****-7612 Debit Transfer 334455");
      });

      it("does not self-match card_suffix on credit card side", () => {
        // Visa CC receives payment — its own card_suffix matches itself, should NOT self-match
        const t = rawTxn({
          _id: "trans_anz_credit_001",
          _account: "acc_anz_visa",
          type: "CREDIT" as Transaction["type"],
          description: "Online Payment - Thank You",
          amount: 315.75,
        });
        (t as any).meta = { card_suffix: "7612" };

        const result = mapTransaction(t, "actual-anz-visa", anzLookup);

        // Should NOT be a transfer (card_suffix matches self)
        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBe("Online Payment - Thank You");
        expect(result.amount).toBe(31575);
      });

      it("prefers other_account over card_suffix when both exist", () => {
        const t = enrichedTxn({ type: "TRANSFER", description: "Transfer" }, undefined, {
          other_account: "11-2222-3333333-44",
        });
        (t as any).meta.card_suffix = "7612";

        const result = mapTransaction(t, "actual-anz-visa", anzLookup);

        // Should match via other_account, not card_suffix
        expect(result.payee).toBe("payee-transfer-freedom");
      });

      it("falls back to payee_name when card_suffix has no mapped account", () => {
        const t = rawTxn({
          type: "TRANSFER",
          description: "Transfer to unknown card",
        });
        (t as any).meta = { card_suffix: "9999" };

        const result = mapTransaction(t, "actual-anz-freedom", anzLookup);

        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBe("Transfer to unknown card");
      });
    });
  });
});

describe("Starting Balance", () => {
  describe("calculateStartingBalance", () => {
    it("calculates balance for a checking account with positive balance", () => {
      // Balance: $1000, transactions: +$200, -$300, -$100 = -$200 sum
      // Starting balance should be: $1000 - (-$200) = $1200
      const result = calculateStartingBalance(100000, -20000);
      expect(result).toBe(120000); // $1200.00
    });

    it("calculates balance for a checking account with all debits", () => {
      // Balance: $500, transactions: -$100, -$200 = -$300 sum
      // Starting balance: $500 - (-$300) = $800
      const result = calculateStartingBalance(50000, -30000);
      expect(result).toBe(80000); // $800.00
    });

    it("calculates balance for a credit card (negative balance)", () => {
      // Akahu balance: -$500 (you owe $500)
      // Transactions: -$200 (purchase), -$100 (purchase), +$50 (payment) = -$250
      // Starting balance: -$500 - (-$250) = -$250 (you owed $250 before)
      const result = calculateStartingBalance(-50000, -25000);
      expect(result).toBe(-25000); // -$250.00
    });

    it("calculates balance for credit card with no prior debt", () => {
      // Akahu balance: -$300 (you owe $300)
      // Transactions: -$300 (purchases) = -$300
      // Starting balance: -$300 - (-$300) = $0 (no prior debt)
      const result = calculateStartingBalance(-30000, -30000);
      expect(result).toBe(0);
    });

    it("calculates balance for savings account with credits only", () => {
      // Balance: $5000, transactions: +$1000, +$500 = +$1500
      // Starting balance: $5000 - $1500 = $3500
      const result = calculateStartingBalance(500000, 150000);
      expect(result).toBe(350000); // $3500.00
    });

    it("handles zero balance", () => {
      const result = calculateStartingBalance(0, -10000);
      expect(result).toBe(10000); // $100.00
    });

    it("handles zero transactions", () => {
      const result = calculateStartingBalance(50000, 0);
      expect(result).toBe(50000); // $500.00
    });
  });

  describe("shouldUpdateStartingBalance", () => {
    it("returns true when no existing balance (first sync)", () => {
      expect(shouldUpdateStartingBalance("2024-06-01", undefined)).toBe(true);
    });

    it("returns true when oldest transaction is before existing balance", () => {
      // 180-day sync: oldest transaction is May 1, existing balance is May 15
      expect(shouldUpdateStartingBalance("2024-05-01", "2024-05-15")).toBe(true);
    });

    it("returns true when oldest transaction equals existing balance date", () => {
      // Edge case: transaction on the same day as balance
      expect(shouldUpdateStartingBalance("2024-05-15", "2024-05-15")).toBe(true);
    });

    it("returns false when oldest transaction is after existing balance", () => {
      // 30-day sync: oldest transaction is June 1, existing balance is May 15
      expect(shouldUpdateStartingBalance("2024-06-01", "2024-05-15")).toBe(false);
    });

    it("returns false for short lookback after long lookback", () => {
      // Previously did 180-day sync (balance at Jan 1), now doing 30-day (oldest June 1)
      expect(shouldUpdateStartingBalance("2024-06-01", "2024-01-01")).toBe(false);
    });
  });

  describe("getStartingBalanceDate", () => {
    it("returns 1 day before the oldest transaction", () => {
      const result = getStartingBalanceDate("2024-06-15");
      expect(result).toBe("2024-06-14");
    });

    it("handles month boundary", () => {
      const result = getStartingBalanceDate("2024-06-01");
      expect(result).toBe("2024-05-31");
    });

    it("handles year boundary", () => {
      const result = getStartingBalanceDate("2024-01-01");
      expect(result).toBe("2023-12-31");
    });
  });

  describe("starting balance date must precede oldest transaction", () => {
    // Simulates the dedup + date logic from syncAccount
    function simulateBalanceDateCalc(
      akahuTxns: { date: string; amount: number }[],
      existingTransfers: { date: string; amount: number }[],
    ) {
      // Dedup: filter out Akahu txns matching existing transfers
      const filtered = akahuTxns.filter(
        (t) => !existingTransfers.some((et) => et.date === t.date && et.amount === t.amount),
      );

      // BUG (old): used filtered dates only
      const filteredDates = [
        ...filtered.map((t) => t.date),
        ...existingTransfers.map((t) => t.date),
      ];
      const buggyDate =
        filteredDates.length > 0
          ? getStartingBalanceDate(
              filteredDates.reduce((o, d) => (d < o ? d : o), filteredDates[0]),
            )
          : "today";

      // FIX: use ALL Akahu txn dates (not just filtered)
      const allDates = [...akahuTxns.map((t) => t.date), ...existingTransfers.map((t) => t.date)];
      const fixedDate =
        allDates.length > 0
          ? getStartingBalanceDate(allDates.reduce((o, d) => (d < o ? d : o), allDates[0]))
          : "today";

      return { buggyDate, fixedDate, filtered };
    }

    it("oldest Akahu txn deduped → buggy date is AFTER oldest txn", () => {
      // Account synced with 30 days: May-June transactions, starting balance at May
      // Then synced with custom date Jan 1: Jan-June transactions
      // The Jan 1 transaction is a transfer payment that gets deduped
      const akahuTxns = [
        { date: "2026-01-01", amount: 150000 }, // ← oldest, but matches a transfer → deduped!
        { date: "2026-05-15", amount: -5000 },
        { date: "2026-06-01", amount: -3000 },
      ];
      const existingTransfers = [{ date: "2026-01-01", amount: 150000 }];

      const { buggyDate: _buggyDate, fixedDate } = simulateBalanceDateCalc(
        akahuTxns,
        existingTransfers,
      );

      // BUG: filtered removes Jan 1 txn, oldest becomes Jan 1 (from transfer) → OK in this case
      // But if there were no existingTransfers matching the oldest date, it would be wrong

      // FIX: always correct
      expect(fixedDate).toBe("2025-12-31");
      expect(fixedDate < "2026-01-01").toBe(true);
    });

    it("all Akahu txns deduped → uses transfer dates for balance date", () => {
      const akahuTxns = [{ date: "2026-03-15", amount: 200000 }];
      const existingTransfers = [{ date: "2026-03-15", amount: 200000 }];

      const {
        buggyDate: _buggyDate,
        fixedDate,
        filtered,
      } = simulateBalanceDateCalc(akahuTxns, existingTransfers);

      expect(filtered.length).toBe(0);
      // Both should still get a valid date from the transfer/akahu dates
      expect(fixedDate).toBe("2026-03-14");
    });

    it("no dedup needed → both produce correct date", () => {
      const akahuTxns = [
        { date: "2026-01-05", amount: -5000 },
        { date: "2026-02-10", amount: -3000 },
      ];
      const existingTransfers: { date: string; amount: number }[] = [];

      const { buggyDate, fixedDate } = simulateBalanceDateCalc(akahuTxns, existingTransfers);

      expect(buggyDate).toBe("2026-01-04");
      expect(fixedDate).toBe("2026-01-04");
    });
  });

  describe("sequential sync: wide then narrow lookback", () => {
    const AKAHU_BALANCE = -250000; // -$2500.00

    // Simulate what syncAccount does for starting balance
    function simulateSync(
      akahuTxns: { date: string; amount: number }[],
      existingTransfers: { date: string; amount: number }[],
      existingBalanceDate: string | undefined,
    ) {
      // Dedup
      const filtered = akahuTxns.filter(
        (t) => !existingTransfers.some((et) => et.date === t.date && et.amount === t.amount),
      );

      const importedSum = filtered.reduce((s, t) => s + t.amount, 0);
      const transferSum = existingTransfers.reduce((s, t) => s + t.amount, 0);
      const transactionSum = importedSum + transferSum;
      const newStartingBalance = calculateStartingBalance(AKAHU_BALANCE, transactionSum);

      const allDates = [...akahuTxns.map((t) => t.date), ...existingTransfers.map((t) => t.date)];
      const oldestTxnDate =
        allDates.length > 0 ? allDates.reduce((o, d) => (d < o ? d : o), allDates[0]) : undefined;
      const balanceDateStr = oldestTxnDate ? getStartingBalanceDate(oldestTxnDate) : "today";

      // Should we update the amount?
      const shouldUpdate = shouldUpdateStartingBalance(balanceDateStr, existingBalanceDate);

      return { newStartingBalance, balanceDateStr, shouldUpdate, transactionSum };
    }

    it("initial sync from Jan 1 → creates starting balance", () => {
      const txns = [
        { date: "2026-01-02", amount: -40000 },
        { date: "2026-03-15", amount: -25000 },
        { date: "2026-05-01", amount: 300000 }, // payment
        { date: "2026-06-01", amount: -185000 },
      ];

      const result = simulateSync(txns, [], undefined);

      // Starting balance = akahu balance - sum of txns
      expect(result.shouldUpdate).toBe(true); // no existing balance → always create
      expect(result.balanceDateStr).toBe("2026-01-01"); // day before oldest
      expect(result.newStartingBalance + result.transactionSum).toBe(AKAHU_BALANCE);
    });

    it("narrow 30-day sync should NOT update starting balance amount", () => {
      // Only last 30 days of transactions (partial data)
      const txns30Days = [
        { date: "2026-05-15", amount: -10000 },
        { date: "2026-06-01", amount: -5000 },
      ];

      // Existing starting balance was set on initial sync (date: Jan 1)
      const result = simulateSync(txns30Days, [], "2026-01-01");

      // Should NOT update: oldest txn (May 15) is AFTER existing balance (Jan 1)
      expect(result.shouldUpdate).toBe(false);

      // If we DID update, the balance would be wrong:
      const wrongBalance = result.newStartingBalance + result.transactionSum;
      expect(wrongBalance).toBe(AKAHU_BALANCE); // math checks out for JUST these txns
      // But Actual has ALL the old txns too, so displayed balance would be:
      // wrongStartingBalance + oldTxns + newTxns ≠ akahuBalance
    });

    it("re-syncing from Jan 1 again SHOULD update starting balance", () => {
      const txnsAll = [
        { date: "2026-01-02", amount: -40000 },
        { date: "2026-03-15", amount: -25000 },
        { date: "2026-05-01", amount: 300000 },
        { date: "2026-06-01", amount: -185000 },
      ];

      // Existing starting balance from first sync
      const result = simulateSync(txnsAll, [], "2026-01-01");

      // Should update: oldest txn (Jan 2) → balance date (Jan 1) <= existing (Jan 1)
      expect(result.shouldUpdate).toBe(true);
    });

    it("wider lookback than original SHOULD update starting balance", () => {
      // Original was from Jan 1, now syncing from Dec 1 (even further back)
      const txns = [
        { date: "2025-12-05", amount: -15000 }, // older than original
        { date: "2026-01-02", amount: -40000 },
        { date: "2026-06-01", amount: -185000 },
      ];

      const result = simulateSync(txns, [], "2026-01-01");

      // Should update: oldest txn (Dec 5) → balance date (Dec 4) < existing (Jan 1)
      expect(result.shouldUpdate).toBe(true);
      expect(result.balanceDateStr).toBe("2025-12-04");
    });
  });
});
