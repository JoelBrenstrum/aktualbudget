import { describe, expect, it } from "vitest";
import type { Transaction } from "akahu";
import {
  toLocalDateStr,
  getMerchantName,
  getOtherAccount,
  getCardSuffix,
  getParticularsCardSuffix,
  getPayeeAndNotes,
  mergeMetaAccount,
  mapTransaction,
  deduplicateTransfers,
  looksLikeTransfer,
  calculateStartingBalance,
  shouldUpdateStartingBalance,
  getStartingBalanceDate,
  hasTransactionsBeforeDate,
  findStalePendingTransactions,
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

// --- getParticularsCardSuffix ---

describe("getParticularsCardSuffix", () => {
  it("extracts card suffix from TO CARD particulars", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "TO CARD 7162", reference: "groceries" };
    expect(getParticularsCardSuffix(t)).toBe("7162");
  });

  it("extracts card suffix from FROM CARD particulars", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "FROM CARD 7162" };
    expect(getParticularsCardSuffix(t)).toBe("7162");
  });

  it("handles surrounding whitespace and lowercase", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: " to card 7162 " };
    expect(getParticularsCardSuffix(t)).toBe("7162");
  });

  it("returns undefined for ordinary particulars", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "Water", reference: "INV99201" };
    expect(getParticularsCardSuffix(t)).toBeUndefined();
  });

  it("returns undefined for split account-number particulars", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "TO 38-1234- ", code: "5678901-23" };
    expect(getParticularsCardSuffix(t)).toBeUndefined();
  });

  it("returns undefined when particulars embeds extra text", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "PAYMENT TO CARD 7162 THANKS" };
    expect(getParticularsCardSuffix(t)).toBeUndefined();
  });

  it("returns undefined for raw transaction without meta", () => {
    expect(getParticularsCardSuffix(rawTxn())).toBeUndefined();
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

    describe("split meta account merge", () => {
      const mergeLookup: TransferLookup = {
        bankNumberToActualId: new Map([
          ["38-1234-5678901-23", "actual-savings"],
          ["41-5678-9012345-67", "actual-freedom"],
        ]),
        cardSuffixToActualId: new Map(),
        actualIdToTransferPayeeId: new Map([
          ["actual-savings", "payee-transfer-savings"],
          ["actual-freedom", "payee-transfer-freedom"],
        ]),
      };

      it("detects transfer from split particulars+code with TO prefix", () => {
        const t = rawTxn({
          description: "Savings Transfer",
          amount: -500,
        });
        (t as any).meta = {
          particulars: "TO 38-1234- ",
          code: "5678901-23",
          reference: "Savings",
        };

        const result = mapTransaction(t, "actual-checking", mergeLookup);
        expect(result.payee).toBe("payee-transfer-savings");
        expect(result.payee_name).toBeUndefined();
      });

      it("detects transfer from split particulars+code with FROM prefix", () => {
        const t = rawTxn({
          description: "Transfer from Freedom",
          amount: 200,
        });
        (t as any).meta = {
          particulars: "FROM 41-5678-",
          code: "9012345-67",
        };

        const result = mapTransaction(t, "actual-checking", mergeLookup);
        expect(result.payee).toBe("payee-transfer-freedom");
      });

      it("does not self-match merged account", () => {
        const t = rawTxn({ description: "Internal" });
        (t as any).meta = {
          particulars: "TO 38-1234- ",
          code: "5678901-23",
        };

        const result = mapTransaction(t, "actual-savings", mergeLookup);
        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBeDefined();
      });

      it("falls back to payee_name when merged account not in mappings", () => {
        const t = rawTxn({ description: "Unknown transfer" });
        (t as any).meta = {
          particulars: "TO 99-9999- ",
          code: "9999999-00",
        };

        const result = mapTransaction(t, "actual-checking", mergeLookup);
        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBeDefined();
      });

      it("prefers other_account over merged meta account", () => {
        const t = rawTxn({ description: "Transfer" });
        (t as any).meta = {
          other_account: "41-5678-9012345-67",
          particulars: "TO 38-1234- ",
          code: "5678901-23",
        };

        const result = mapTransaction(t, "actual-checking", mergeLookup);
        // Should match via other_account (freedom), not merged (savings)
        expect(result.payee).toBe("payee-transfer-freedom");
      });
    });

    describe("credit card via TO CARD particulars (BNZ)", () => {
      // BNZ mobile-banking transfers to a credit card carry no other_account,
      // no card_suffix, and no full account number — only "TO CARD XXXX" in
      // meta.particulars (plus an optional user reference).

      const cardLookup: TransferLookup = {
        bankNumberToActualId: new Map([
          ["02-0100-0100001-07", "actual-joint"],
          ["4835-****-****-7162", "actual-credit-card"],
        ]),
        cardSuffixToActualId: new Map([
          ["0107", "actual-joint"],
          ["7162", "actual-credit-card"],
        ]),
        actualIdToTransferPayeeId: new Map([
          ["actual-joint", "payee-transfer-joint"],
          ["actual-credit-card", "payee-transfer-cc"],
        ]),
      };

      it("creates a transfer from the bank leg with TO CARD particulars", () => {
        // Real bug: joint account → credit card payment was imported as a
        // plain transaction instead of a transfer
        const t = rawTxn({
          _id: "trans_cmrlbhurt0qer02l17ymdb2sf",
          _account: "acc_cmq1f6oji00bb02jpb2zhgwoa",
          description: "MB TRANSFER TO CARD 7162groceries",
          amount: -166.47,
          type: "TRANSFER",
          date: "2026-07-13T12:00:00.000Z",
        });
        (t as any).meta = { particulars: "TO CARD 7162", reference: "groceries" };

        const result = mapTransaction(t, "actual-joint", cardLookup);

        expect(result.payee).toBe("payee-transfer-cc");
        expect(result.payee_name).toBeUndefined();
        expect(result.amount).toBe(-16647);
        expect(result.notes).toBe("MB TRANSFER TO CARD 7162groceries");
      });

      it("does not self-match the card's own suffix", () => {
        const t = rawTxn({ description: "CARD PAYMENT", amount: -50 });
        (t as any).meta = { particulars: "TO CARD 7162" };

        const result = mapTransaction(t, "actual-credit-card", cardLookup);
        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBeDefined();
      });

      it("falls back to payee_name when card suffix is not mapped", () => {
        const t = rawTxn({ description: "MB TRANSFER TO CARD 9999" });
        (t as any).meta = { particulars: "TO CARD 9999" };

        const result = mapTransaction(t, "actual-joint", cardLookup);
        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBeDefined();
      });

      it("prefers other_account over TO CARD particulars", () => {
        const t = rawTxn({ description: "Transfer" });
        (t as any).meta = {
          other_account: "02-0100-0100001-07",
          particulars: "TO CARD 7162",
        };

        const result = mapTransaction(t, "actual-checking", cardLookup);
        expect(result.payee).toBe("payee-transfer-joint");
      });

      it("does NOT create a transfer from the card's receiving leg (empty meta)", () => {
        // The counterpart is auto-created by Actual from the bank leg; the
        // card's own "PAYMENT RECEIVED" must import plain (then be deduped).
        const t = rawTxn({
          _id: "trans_cmrmqtrmd1e1302ldgyy52awf",
          _account: "acc_cmq1f6ojv00bd02jp5xzgfxjp",
          description: "PAYMENT RECEIVED groceries",
          amount: 166.47,
          type: "CREDIT CARD" as Transaction["type"],
          date: "2026-07-13T12:00:00.000Z",
        });
        (t as any).meta = {};

        const result = mapTransaction(t, "actual-credit-card", cardLookup);
        expect(result.payee).toBeUndefined();
        expect(result.payee_name).toBe("PAYMENT RECEIVED groceries");
        expect(result.amount).toBe(16647);
      });
    });
  });
});

// --- mergeMetaAccount ---

describe("mergeMetaAccount", () => {
  it("merges particulars + code with TO prefix", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "TO 38-1234- ", code: "5678901-23" };
    expect(mergeMetaAccount(t)).toBe("38-1234-5678901-23");
  });

  it("merges particulars + code with FROM prefix", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "FROM 41-5678-", code: "9012345-67" };
    expect(mergeMetaAccount(t)).toBe("41-5678-9012345-67");
  });

  it("merges without prefix", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "55-7890-", code: "1234567-89" };
    expect(mergeMetaAccount(t)).toBe("55-7890-1234567-89");
  });

  it("returns undefined when result is not a valid NZ account", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "Water", code: "INV99201" };
    expect(mergeMetaAccount(t)).toBeUndefined();
  });

  it("returns undefined when particulars is missing", () => {
    const t = rawTxn();
    (t as any).meta = { code: "5678901-23" };
    expect(mergeMetaAccount(t)).toBeUndefined();
  });

  it("returns undefined when code is missing", () => {
    const t = rawTxn();
    (t as any).meta = { particulars: "TO 38-1234- " };
    expect(mergeMetaAccount(t)).toBeUndefined();
  });

  it("returns undefined for raw transaction without meta", () => {
    expect(mergeMetaAccount(rawTxn())).toBeUndefined();
  });
});

// --- deduplicateTransfers ---

describe("deduplicateTransfers", () => {
  it("filters out incoming transaction that matches an existing transfer", () => {
    const incoming = [{ date: "2026-06-01", amount: -5000, payee_name: "Countdown" }];
    const existing = [{ id: "t1", date: "2026-06-01", amount: -5000 }];
    const { filtered, deduped } = deduplicateTransfers(incoming, existing);
    expect(deduped).toBe(1);
    expect(filtered).toHaveLength(0);
  });

  it("only dedupes one incoming per existing transfer (bug fix)", () => {
    // Two payments for $50 on the same day to different payees,
    // but only one existing transfer — only one should be removed
    const incoming = [
      { date: "2026-06-01", amount: -5000, payee_name: "Countdown" },
      { date: "2026-06-01", amount: -5000, payee_name: "New World" },
    ];
    const existing = [{ id: "t1", date: "2026-06-01", amount: -5000 }];
    const { filtered, deduped } = deduplicateTransfers(incoming, existing);
    expect(deduped).toBe(1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].payee_name).toBe("New World");
  });

  it("dedupes two incoming when two existing transfers match", () => {
    const incoming = [
      { date: "2026-06-01", amount: -5000, payee_name: "Countdown" },
      { date: "2026-06-01", amount: -5000, payee_name: "New World" },
    ];
    const existing = [
      { id: "t1", date: "2026-06-01", amount: -5000 },
      { id: "t2", date: "2026-06-01", amount: -5000 },
    ];
    const { filtered, deduped } = deduplicateTransfers(incoming, existing);
    expect(deduped).toBe(2);
    expect(filtered).toHaveLength(0);
  });

  it("always keeps transactions already mapped as transfers", () => {
    const incoming = [{ date: "2026-06-01", amount: -5000, payee: "payee-transfer-savings" }];
    const existing = [{ id: "t1", date: "2026-06-01", amount: -5000 }];
    const { filtered, deduped } = deduplicateTransfers(incoming, existing);
    expect(deduped).toBe(0);
    expect(filtered).toHaveLength(1);
  });

  it("does not filter when no existing transfers match", () => {
    const incoming = [
      { date: "2026-06-01", amount: -5000, payee_name: "Countdown" },
      { date: "2026-06-02", amount: -3000, payee_name: "Pak n Save" },
    ];
    const existing = [{ id: "t1", date: "2026-06-05", amount: -9999 }];
    const { filtered, deduped } = deduplicateTransfers(incoming, existing);
    expect(deduped).toBe(0);
    expect(filtered).toHaveLength(2);
  });

  it("handles empty inputs", () => {
    expect(deduplicateTransfers([], []).deduped).toBe(0);
    expect(
      deduplicateTransfers([], [{ id: "t1", date: "2026-06-01", amount: -5000 }]).deduped,
    ).toBe(0);
    expect(deduplicateTransfers([{ date: "2026-06-01", amount: -5000 }], []).deduped).toBe(0);
  });
});

// --- hasTransactionsBeforeDate ---

describe("hasTransactionsBeforeDate", () => {
  const balanceId = "aktualsync-starting-balance-acc_123";

  it("returns 0 when no transactions exist", () => {
    expect(hasTransactionsBeforeDate([], "2026-06-01", balanceId)).toBe(0);
  });

  it("returns 0 when all transactions are after the balance date", () => {
    const txns = [
      { date: "2026-06-15", imported_id: "txn_1" },
      { date: "2026-07-01", imported_id: "txn_2" },
    ];
    expect(hasTransactionsBeforeDate(txns, "2026-06-01", balanceId)).toBe(0);
  });

  it("counts transactions on the balance date", () => {
    const txns = [
      { date: "2026-06-01", imported_id: "txn_1" },
      { date: "2026-06-15", imported_id: "txn_2" },
    ];
    expect(hasTransactionsBeforeDate(txns, "2026-06-01", balanceId)).toBe(1);
  });

  it("counts transactions before the balance date", () => {
    const txns = [
      { date: "2026-05-01", imported_id: "txn_1" },
      { date: "2026-05-15", imported_id: "txn_2" },
      { date: "2026-06-15", imported_id: "txn_3" },
    ];
    expect(hasTransactionsBeforeDate(txns, "2026-06-01", balanceId)).toBe(2);
  });

  it("excludes the starting balance transaction itself", () => {
    const txns = [
      { date: "2026-05-31", imported_id: balanceId },
      { date: "2026-06-15", imported_id: "txn_1" },
    ];
    expect(hasTransactionsBeforeDate(txns, "2026-06-01", balanceId)).toBe(0);
  });

  it("handles transactions with null imported_id", () => {
    const txns = [
      { date: "2026-05-15", imported_id: null },
      { date: "2026-06-15", imported_id: "txn_1" },
    ];
    expect(hasTransactionsBeforeDate(txns, "2026-06-01", balanceId)).toBe(1);
  });
});

// --- findStalePendingTransactions ---

describe("findStalePendingTransactions", () => {
  it("finds pending transaction with matching settled counterpart", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual(["pending-1"]);
  });

  it("matches within ±7 day window (Actual's fuzzy-merge window)", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-08",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual(["pending-1"]);
  });

  it("does not match beyond 7 day window", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-09",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
  });

  it("deletes reversed pending: gone from Akahu, no settled match, older than window", () => {
    const txns = [
      {
        id: "pending-reversed",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns, [], 7, "2026-06-09")).toEqual(["pending-reversed"]);
  });

  it("keeps recent orphan pending without settled match (could be settlement lag)", () => {
    const txns = [
      {
        id: "pending-lagging",
        date: "2026-06-05",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns, [], 7, "2026-06-09")).toEqual([]);
  });

  it("does not treat orphan as reversed when today is not provided", () => {
    const txns = [
      {
        id: "pending-old",
        date: "2026-01-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
  });

  it("protects live Akahu pending from reversal cleanup even when old", () => {
    const txns = [
      {
        id: "pending-live-old",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
    ];
    const currentPending = [{ date: "2026-06-01", amount: -5000 }];
    expect(findStalePendingTransactions(txns, currentPending, 7, "2026-06-20")).toEqual([]);
  });

  it("protects pending that still exists in Akahu's current pending list", () => {
    // A Friday card purchase settling on Tuesday sits in Actual for 4+ days.
    // An unrelated same-amount settled transaction must not get it deleted
    // while the bank still reports it as pending.
    const txns = [
      {
        id: "pending-1",
        date: "2026-07-13",
        amount: -1836,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-other",
        date: "2026-07-11",
        amount: -1836,
        cleared: true,
        imported_id: "akahu_other",
        transfer_id: null,
      },
    ];
    const currentPending = [{ date: "2026-07-13", amount: -1836 }];
    expect(findStalePendingTransactions(txns, currentPending)).toEqual([]);
  });

  it("protection is 1:1 — extra same-amount orphan is still cleaned up", () => {
    const txns = [
      {
        id: "pending-live",
        date: "2026-07-13",
        amount: -1836,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "pending-orphan",
        date: "2026-07-10",
        amount: -1836,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-07-11",
        amount: -1836,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    // Akahu still reports one pending, dated July 13 → protects pending-live
    const currentPending = [{ date: "2026-07-13", amount: -1836 }];
    expect(findStalePendingTransactions(txns, currentPending)).toEqual(["pending-orphan"]);
  });

  it("one settled transaction cannot mark two pendings stale (1:1)", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "pending-2",
        date: "2026-06-02",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual(["pending-1"]);
  });

  it("does not match different amounts", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5001,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
  });

  it("ignores transfers (has transfer_id)", () => {
    const txns = [
      {
        id: "transfer-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: "xfer_1",
      },
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
  });

  it("ignores pending with imported_id (already merged)", () => {
    const txns = [
      {
        id: "merged-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: "akahu_456",
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_123",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
  });

  it("finds multiple stale pending transactions", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "pending-2",
        date: "2026-06-05",
        amount: -3000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_1",
        transfer_id: null,
      },
      {
        id: "settled-2",
        date: "2026-06-06",
        amount: -3000,
        cleared: true,
        imported_id: "akahu_2",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual(["pending-1", "pending-2"]);
  });

  it("returns empty for no pending transactions", () => {
    const txns = [
      {
        id: "settled-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: true,
        imported_id: "akahu_1",
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
  });

  it("returns empty when no settled match exists", () => {
    const txns = [
      {
        id: "pending-1",
        date: "2026-06-01",
        amount: -5000,
        cleared: false,
        imported_id: null,
        transfer_id: null,
      },
    ];
    expect(findStalePendingTransactions(txns)).toEqual([]);
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

  describe("starting balance date is derived from sync start date", () => {
    it("balance date is 1 day before sync start, not based on transactions", () => {
      // Sync start: Jan 1. Oldest transaction: Jan 15.
      // Balance date should be Dec 31 (sync start - 1), not Jan 14.
      const syncStartDate = "2026-01-01";
      const balanceDateStr = getStartingBalanceDate(syncStartDate);
      expect(balanceDateStr).toBe("2025-12-31");
    });

    it("balance date is independent of which transactions exist", () => {
      // Even if all transactions are in June, if we synced from Jan 1,
      // the balance date should be Dec 31.
      const syncStartDate = "2026-01-01";
      expect(getStartingBalanceDate(syncStartDate)).toBe("2025-12-31");
    });

    it("custom start date produces correct balance date", () => {
      const syncStartDate = "2026-03-15";
      expect(getStartingBalanceDate(syncStartDate)).toBe("2026-03-14");
    });
  });

  describe("sequential sync: wide then narrow lookback", () => {
    const AKAHU_BALANCE = -250000; // -$2500.00

    // Simulate what syncAccount does for starting balance
    function simulateSync(
      syncStartDate: string,
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

      // Balance date = sync start date - 1 day
      const balanceDateStr = getStartingBalanceDate(syncStartDate);

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

      const result = simulateSync("2026-01-01", txns, [], undefined);

      // Starting balance = akahu balance - sum of txns
      expect(result.shouldUpdate).toBe(true); // no existing balance → always create
      expect(result.balanceDateStr).toBe("2025-12-31"); // day before sync start
      expect(result.newStartingBalance + result.transactionSum).toBe(AKAHU_BALANCE);
    });

    it("narrow 30-day sync should NOT update starting balance amount", () => {
      // Sync start: May 14. Only last 30 days of transactions.
      const txns30Days = [
        { date: "2026-05-15", amount: -10000 },
        { date: "2026-06-01", amount: -5000 },
      ];

      // Existing starting balance was set on initial sync (date: Dec 31)
      const result = simulateSync("2026-05-14", txns30Days, [], "2025-12-31");

      // Should NOT update: balance date (May 13) is AFTER existing balance (Dec 31)
      expect(result.shouldUpdate).toBe(false);
    });

    it("re-syncing from Jan 1 again SHOULD update starting balance", () => {
      const txnsAll = [
        { date: "2026-01-02", amount: -40000 },
        { date: "2026-03-15", amount: -25000 },
        { date: "2026-05-01", amount: 300000 },
        { date: "2026-06-01", amount: -185000 },
      ];

      // Existing starting balance from first sync
      const result = simulateSync("2026-01-01", txnsAll, [], "2025-12-31");

      // Should update: balance date (Dec 31) <= existing (Dec 31)
      expect(result.shouldUpdate).toBe(true);
    });

    it("wider lookback than original SHOULD update starting balance", () => {
      // Original was from Jan 1 (balance Dec 31), now syncing from Dec 1
      const txns = [
        { date: "2025-12-05", amount: -15000 }, // older than original
        { date: "2026-01-02", amount: -40000 },
        { date: "2026-06-01", amount: -185000 },
      ];

      const result = simulateSync("2025-12-01", txns, [], "2025-12-31");

      // Should update: balance date (Nov 30) < existing (Dec 31)
      expect(result.shouldUpdate).toBe(true);
      expect(result.balanceDateStr).toBe("2025-11-30");
    });
  });
});

describe("transfer-like dedup filtering", () => {
  // Simulates the dedup logic from syncAccount:
  // 1. Identify which Akahu transactions are "transfer-like" (have other_account or card_suffix)
  // 2. Only dedup mapped transactions whose imported_id is in the transfer-like set
  // 3. Non-transfer transactions (standing orders, direct debits) should never be deduped
  function simulateDedup(
    akahuTransactions: Transaction[],
    mappedTransactions: {
      imported_id?: string;
      payee?: string;
      payee_name?: string;
      date: string;
      amount: number;
    }[],
    existingTransfers: { date: string; amount: number }[],
  ) {
    // Step 1: identify transfer-like IDs (mirrors syncAccount, which uses looksLikeTransfer)
    const transferLikeIds = new Set<string>();
    for (const t of akahuTransactions) {
      if (looksLikeTransfer(t)) {
        transferLikeIds.add(t._id);
      }
    }

    // Step 2: filter (same logic as syncAccount)
    const filtered = mappedTransactions.filter((t) => {
      if (t.payee) return true;
      if (!t.imported_id || !transferLikeIds.has(t.imported_id)) return true;

      return !existingTransfers.some((et) => et.date === t.date && et.amount === t.amount);
    });

    return { filtered, transferLikeIds };
  }

  it("does NOT dedup standing order without other_account or card_suffix", () => {
    // This is the exact bug scenario: a standing order to Kernel with only
    // particulars and reference (no other_account, no card_suffix)
    const standingOrder = rawTxn({
      _id: "trans_cmqihwmw40vq102jidbz3bw30",
      description: "TFR TO Kernel NNS7EVWTNNS7EVWT",
      amount: -400,
      type: "STANDING ORDER" as Transaction["type"],
      date: "2026-06-17T12:00:00.000Z",
    });
    (standingOrder as any).meta = {
      particulars: "NNS7EVWT",
      reference: "NNS7EVWT",
    };

    const mapped = {
      imported_id: "trans_cmqihwmw40vq102jidbz3bw30",
      payee_name: "TFR TO Kernel",
      date: "2026-06-18", // NZ date
      amount: -40000,
    };

    // Existing transfer with same date and amount (the false positive)
    const existingTransfers = [{ date: "2026-06-18", amount: -40000 }];

    const { filtered } = simulateDedup([standingOrder], [mapped], existingTransfers);

    // Should NOT be deduped — standing order is not transfer-like
    expect(filtered).toHaveLength(1);
    expect(filtered[0].imported_id).toBe("trans_cmqihwmw40vq102jidbz3bw30");
  });

  it("DOES dedup transaction with other_account matching existing transfer", () => {
    const transfer = enrichedTxn(
      {
        _id: "trans_transfer_001",
        description: "Transfer to Savings",
        amount: -400,
        type: "TRANSFER",
        date: "2026-06-17T12:00:00.000Z",
      },
      undefined,
      { other_account: "02-0100-0100001-07" },
    );

    const mapped = {
      imported_id: "trans_transfer_001",
      payee_name: "Transfer to Savings",
      date: "2026-06-18",
      amount: -40000,
    };

    const existingTransfers = [{ date: "2026-06-18", amount: -40000 }];

    const { filtered } = simulateDedup([transfer], [mapped], existingTransfers);

    // Should be deduped — has other_account, matches existing transfer
    expect(filtered).toHaveLength(0);
  });

  it("DOES dedup transaction with card_suffix matching existing transfer", () => {
    const cardTransfer = rawTxn({
      _id: "trans_card_001",
      description: "Card Payment",
      amount: -250,
      type: "TRANSFER",
      date: "2026-06-17T12:00:00.000Z",
    });
    (cardTransfer as any).meta = { card_suffix: "7612" };

    const mapped = {
      imported_id: "trans_card_001",
      payee_name: "Card Payment",
      date: "2026-06-18",
      amount: -25000,
    };

    const existingTransfers = [{ date: "2026-06-18", amount: -25000 }];

    const { filtered } = simulateDedup([cardTransfer], [mapped], existingTransfers);

    // Should be deduped — has card_suffix
    expect(filtered).toHaveLength(0);
  });

  it("keeps transfer-like transaction when no matching existing transfer", () => {
    const transfer = enrichedTxn(
      {
        _id: "trans_transfer_002",
        description: "Transfer to Savings",
        amount: -500,
        type: "TRANSFER",
        date: "2026-06-17T12:00:00.000Z",
      },
      undefined,
      { other_account: "02-0100-0100001-07" },
    );

    const mapped = {
      imported_id: "trans_transfer_002",
      payee_name: "Transfer to Savings",
      date: "2026-06-18",
      amount: -50000,
    };

    // Existing transfer on different date or amount
    const existingTransfers = [{ date: "2026-06-19", amount: -50000 }];

    const { filtered } = simulateDedup([transfer], [mapped], existingTransfers);

    // Should NOT be deduped — no matching existing transfer
    expect(filtered).toHaveLength(1);
  });

  it("skips dedup check for transactions already mapped as transfers (payee set)", () => {
    const transfer = enrichedTxn(
      {
        _id: "trans_mapped_001",
        description: "Transfer",
        amount: -400,
        type: "TRANSFER",
        date: "2026-06-17T12:00:00.000Z",
      },
      undefined,
      { other_account: "02-0100-0100001-07" },
    );

    const mapped = {
      imported_id: "trans_mapped_001",
      payee: "payee-transfer-savings", // already mapped as a transfer
      date: "2026-06-18",
      amount: -40000,
    };

    const existingTransfers = [{ date: "2026-06-18", amount: -40000 }];

    const { filtered } = simulateDedup([transfer], [mapped], existingTransfers);

    // Should be kept — already has payee (transfer mapping), dedup skipped
    expect(filtered).toHaveLength(1);
  });

  it("handles mix of transfer-like and non-transfer transactions correctly", () => {
    // Two Akahu transactions on the same date with the same amount:
    // 1. A standing order to Kernel (NOT transfer-like)
    // 2. A bank transfer (IS transfer-like)
    const standingOrder = rawTxn({
      _id: "trans_standing_001",
      description: "TFR TO Kernel NNS7EVWT",
      amount: -400,
      type: "STANDING ORDER" as Transaction["type"],
      date: "2026-06-17T12:00:00.000Z",
    });
    (standingOrder as any).meta = { particulars: "NNS7EVWT", reference: "NNS7EVWT" };

    const transfer = enrichedTxn(
      {
        _id: "trans_bank_transfer_001",
        description: "Transfer to Savings",
        amount: -400,
        type: "TRANSFER",
        date: "2026-06-17T12:00:00.000Z",
      },
      undefined,
      { other_account: "02-0100-0100001-07" },
    );

    const mappedStanding = {
      imported_id: "trans_standing_001",
      payee_name: "TFR TO Kernel",
      date: "2026-06-18",
      amount: -40000,
    };

    const mappedTransfer = {
      imported_id: "trans_bank_transfer_001",
      payee_name: "Transfer to Savings",
      date: "2026-06-18",
      amount: -40000,
    };

    // One existing transfer counterpart for -$400 on that date
    const existingTransfers = [{ date: "2026-06-18", amount: -40000 }];

    const { filtered } = simulateDedup(
      [standingOrder, transfer],
      [mappedStanding, mappedTransfer],
      existingTransfers,
    );

    // Standing order should be kept (not transfer-like)
    // Bank transfer should be deduped (transfer-like, matches existing)
    expect(filtered).toHaveLength(1);
    expect(filtered[0].imported_id).toBe("trans_standing_001");
  });

  it("correctly identifies transfer-like transactions", () => {
    const withOtherAccount = enrichedTxn({ _id: "t1" }, undefined, {
      other_account: "02-0100-0100001-07",
    });

    const withCardSuffix = rawTxn({ _id: "t2" });
    (withCardSuffix as any).meta = { card_suffix: "7612" };

    const withBothMeta = enrichedTxn({ _id: "t3" }, undefined, {
      other_account: "12-3000-0080008-00",
    });
    (withBothMeta as any).meta.card_suffix = "4321";

    const withOnlyParticulars = rawTxn({ _id: "t4" });
    (withOnlyParticulars as any).meta = { particulars: "NNS7EVWT", reference: "NNS7EVWT" };

    const noMeta = rawTxn({ _id: "t5" });

    const { transferLikeIds } = simulateDedup(
      [withOtherAccount, withCardSuffix, withBothMeta, withOnlyParticulars, noMeta],
      [],
      [],
    );

    expect(transferLikeIds.has("t1")).toBe(true); // other_account
    expect(transferLikeIds.has("t2")).toBe(true); // card_suffix
    expect(transferLikeIds.has("t3")).toBe(true); // both
    expect(transferLikeIds.has("t4")).toBe(false); // only particulars/reference
    expect(transferLikeIds.has("t5")).toBe(false); // no meta at all
  });

  it("flags the received leg of an internal transfer (EX prefix) as transfer-like", () => {
    // Real bug: the receiving leg of an internal transfer arrives with an "EX"
    // particulars prefix (not TO/FROM), so mergeMetaAccount does NOT turn it into
    // a transfer — it's imported plain. Its counterpart is auto-created by Actual
    // from the sending ("TO") leg, so the plain import must be recognised as
    // transfer-like to be cleaned up (otherwise the account doubles by the amount).
    const receivedLeg = rawTxn({
      _id: "trans_cmrmqtrla1e0702ld963a6ze4",
      description: "PM TRANSFER EX 12-3072- 0400082-56expenses",
      amount: 1200,
      type: "CREDIT",
      date: "2026-07-15T12:00:00.000Z",
    });
    (receivedLeg as any).meta = {
      particulars: "EX 12-3072- ",
      code: "0400082-56",
      reference: "expenses",
    };

    // It must be flagged transfer-like (so post-sync cleanup can dedup it)...
    expect(looksLikeTransfer(receivedLeg)).toBe(true);
    // ...but must NOT itself be turned into a transfer (only the "TO" leg does that,
    // otherwise both legs would create transfers and double both accounts).
    expect(mergeMetaAccount(receivedLeg)).toBeUndefined();
  });

  it("still creates a transfer from the sending leg (TO prefix)", () => {
    const sendingLeg = rawTxn({
      _id: "trans_cmrmqtrj11dz102ld8q45c0qb",
      description: "PM TRANSFER TO 12-3274- 0243409-00expenses",
      amount: -1200,
      type: "DIRECT DEBIT" as Transaction["type"],
      date: "2026-07-15T12:00:00.000Z",
    });
    (sendingLeg as any).meta = {
      particulars: "TO 12-3274- ",
      code: "0243409-00",
      reference: "expenses",
    };

    expect(looksLikeTransfer(sendingLeg)).toBe(true);
    expect(mergeMetaAccount(sendingLeg)).toBe("12-3274-0243409-00");
  });

  it("does NOT dedup direct debit without transfer indicators", () => {
    const directDebit = rawTxn({
      _id: "trans_dd_001",
      description: "POWER COMPANY LTD",
      amount: -150,
      type: "DIRECT DEBIT" as Transaction["type"],
      date: "2026-06-17T12:00:00.000Z",
    });
    (directDebit as any).meta = { particulars: "ELEC", reference: "ACC123456" };

    const mapped = {
      imported_id: "trans_dd_001",
      payee_name: "POWER COMPANY LTD",
      date: "2026-06-18",
      amount: -15000,
    };

    // Coincidentally matching existing transfer
    const existingTransfers = [{ date: "2026-06-18", amount: -15000 }];

    const { filtered } = simulateDedup([directDebit], [mapped], existingTransfers);

    expect(filtered).toHaveLength(1);
  });

  it("DOES dedup credit card payment (type CREDIT CARD) against a transfer counterpart", () => {
    // Since the bank leg ("TO CARD 7162") now creates a real transfer, its
    // auto-created counterpart lands on the credit card. The card's own
    // "PAYMENT RECEIVED" leg (empty meta, type CREDIT CARD) must reconcile
    // against it or the card double-counts every payment.
    const ccPayment = rawTxn({
      _id: "trans_cmrmqtrmd1e1302ldgyy52awf",
      _account: "acc_cmq1f6ojv00bd02jp5xzgfxjp",
      description: "PAYMENT RECEIVED groceries",
      amount: 166.47,
      type: "CREDIT CARD" as Transaction["type"],
      date: "2026-07-13T12:00:00.000Z",
    });
    (ccPayment as any).meta = {};

    const mapped = {
      imported_id: "trans_cmrmqtrmd1e1302ldgyy52awf",
      payee_name: "PAYMENT RECEIVED groceries",
      date: "2026-07-14", // NZ date
      amount: 16647,
    };

    // Counterpart auto-created by the bank leg's transfer
    const existingTransfers = [{ date: "2026-07-14", amount: 16647 }];

    const { filtered, transferLikeIds } = simulateDedup([ccPayment], [mapped], existingTransfers);

    expect(transferLikeIds.has("trans_cmrmqtrmd1e1302ldgyy52awf")).toBe(true);
    expect(filtered).toHaveLength(0);
  });

  it("keeps credit card payment when no transfer counterpart matches", () => {
    // A payment from an unmapped external account: transfer-like, but there is
    // no counterpart to reconcile against, so it must be imported.
    const ccPayment = rawTxn({
      _id: "trans_cc_external_001",
      description: "PAYMENT RECEIVED THANK YOU",
      amount: 500,
      type: "CREDIT CARD" as Transaction["type"],
      date: "2026-07-13T12:00:00.000Z",
    });
    (ccPayment as any).meta = {};

    const mapped = {
      imported_id: "trans_cc_external_001",
      payee_name: "PAYMENT RECEIVED THANK YOU",
      date: "2026-07-14",
      amount: 50000,
    };

    const { filtered } = simulateDedup([ccPayment], [mapped], []);

    expect(filtered).toHaveLength(1);
  });

  it("does NOT treat negative CREDIT CARD transactions as transfer-like", () => {
    // Only payments *onto* the card (positive) are transfer legs
    const reversal = rawTxn({
      _id: "trans_cc_reversal_001",
      description: "PAYMENT REVERSAL",
      amount: -166.47,
      type: "CREDIT CARD" as Transaction["type"],
    });
    (reversal as any).meta = {};

    expect(looksLikeTransfer(reversal)).toBe(false);
  });

  it("flags the TO CARD bank leg as transfer-like", () => {
    const bankLeg = rawTxn({
      _id: "trans_cmrlbhurt0qer02l17ymdb2sf",
      description: "MB TRANSFER TO CARD 7162groceries",
      amount: -166.47,
      type: "TRANSFER",
      date: "2026-07-13T12:00:00.000Z",
    });
    (bankLeg as any).meta = { particulars: "TO CARD 7162", reference: "groceries" };

    expect(looksLikeTransfer(bankLeg)).toBe(true);
  });

  it("bank-to-card payment: bank leg becomes a transfer, card leg is deduped", () => {
    // End-to-end shape of the real bug: joint account sends -$166.47
    // "MB TRANSFER TO CARD 7162", credit card receives +$166.47
    // "PAYMENT RECEIVED". The bank leg maps to a transfer payee (kept, creates
    // the counterpart); the card leg matches that counterpart and is dropped.
    const bankLeg = rawTxn({
      _id: "trans_cmrlbhurt0qer02l17ymdb2sf",
      description: "MB TRANSFER TO CARD 7162groceries",
      amount: -166.47,
      type: "TRANSFER",
      date: "2026-07-13T12:00:00.000Z",
    });
    (bankLeg as any).meta = { particulars: "TO CARD 7162", reference: "groceries" };

    const ccLeg = rawTxn({
      _id: "trans_cmrmqtrmd1e1302ldgyy52awf",
      description: "PAYMENT RECEIVED groceries",
      amount: 166.47,
      type: "CREDIT CARD" as Transaction["type"],
      date: "2026-07-13T12:00:00.000Z",
    });
    (ccLeg as any).meta = {};

    const mappedBank = {
      imported_id: "trans_cmrlbhurt0qer02l17ymdb2sf",
      payee: "payee-transfer-cc", // mapped as a transfer via TO CARD particulars
      date: "2026-07-14",
      amount: -16647,
    };

    const mappedCC = {
      imported_id: "trans_cmrmqtrmd1e1302ldgyy52awf",
      payee_name: "PAYMENT RECEIVED groceries",
      date: "2026-07-14",
      amount: 16647,
    };

    // Counterpart on the card created by the bank leg's transfer
    const existingTransfers = [{ date: "2026-07-14", amount: 16647 }];

    const { filtered } = simulateDedup([bankLeg, ccLeg], [mappedBank, mappedCC], existingTransfers);

    // Bank leg kept (it IS the transfer); card leg deduped against counterpart
    expect(filtered).toHaveLength(1);
    expect(filtered[0].imported_id).toBe("trans_cmrlbhurt0qer02l17ymdb2sf");
  });
});
