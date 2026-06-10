import { describe, expect, it } from "vitest";
import type { Transaction } from "akahu";
import {
  toLocalDateStr,
  getMerchantName,
  getOtherAccount,
  mapTransaction,
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
    const t = enrichedTxn({}, undefined, { other_account: "02-0256-0116381-07" });
    expect(getOtherAccount(t)).toBe("02-0256-0116381-07");
  });

  it("returns undefined when meta has no other_account", () => {
    const t = enrichedTxn({}, undefined, {});
    expect(getOtherAccount(t)).toBeUndefined();
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
    expect(result.notes).toBeUndefined();
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
    expect(result.notes).toBeUndefined();
  });

  it("converts amount to cents (integer)", () => {
    expect(mapTransaction(rawTxn({ amount: 120.3 }), accountId, emptyLookup).amount).toBe(12030);
    expect(mapTransaction(rawTxn({ amount: -0.01 }), accountId, emptyLookup).amount).toBe(-1);
    expect(mapTransaction(rawTxn({ amount: 0 }), accountId, emptyLookup).amount).toBe(0);
  });

  describe("transfer detection", () => {
    const transferLookup: TransferLookup = {
      bankNumberToActualId: new Map([
        ["02-0256-0116381-07", "actual-acc-savings"],
        ["12-3107-0086725-00", "actual-acc-credit"],
      ]),
      actualIdToTransferPayeeId: new Map([
        ["actual-acc-savings", "payee-transfer-savings"],
        ["actual-acc-credit", "payee-transfer-credit"],
      ]),
    };

    it("detects transfer when other_account matches mapped account", () => {
      const t = enrichedTxn({ type: "TRANSFER", description: "Transfer to Savings" }, undefined, {
        other_account: "02-0256-0116381-07",
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
        { other_account: "12-3107-0086725-00" },
      );
      const result = mapTransaction(t, accountId, transferLookup);

      expect(result.payee).toBe("payee-transfer-credit");
      expect(result.payee_name).toBeUndefined();
    });

    it("detects transfer for DIRECT CREDIT type", () => {
      const t = enrichedTxn(
        { type: "DIRECT CREDIT" as Transaction["type"], description: "Incoming" },
        undefined,
        { other_account: "02-0256-0116381-07" },
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
  });
});
