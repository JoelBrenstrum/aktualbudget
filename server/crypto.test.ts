import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "./crypto.js";

describe("crypto", () => {
  const password = "test-password-123";
  const plaintext = JSON.stringify({
    actual: { serverUrl: "https://budget.example.com", password: "secret" },
    akahu: { appToken: "app_token_xxx", userToken: "user_token_yyy" },
  });

  describe("encrypt/decrypt round-trip", () => {
    it("decrypts to original plaintext", () => {
      const encrypted = encrypt(plaintext, password);
      const decrypted = decrypt(encrypted, password);
      expect(decrypted).toBe(plaintext);
    });

    it("produces valid base64 output", () => {
      const encrypted = encrypt(plaintext, password);
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
      // Should not be valid JSON (it's encrypted)
      expect(() => JSON.parse(encrypted)).toThrow();
    });

    it("produces different ciphertext each time (random salt/iv)", () => {
      const a = encrypt(plaintext, password);
      const b = encrypt(plaintext, password);
      expect(a).not.toBe(b);
    });

    it("handles empty string", () => {
      const encrypted = encrypt("", password);
      const decrypted = decrypt(encrypted, password);
      expect(decrypted).toBe("");
    });

    it("handles unicode content", () => {
      const unicode = '{"name": "日本語テスト 🔐"}';
      const encrypted = encrypt(unicode, password);
      const decrypted = decrypt(encrypted, password);
      expect(decrypted).toBe(unicode);
    });

    it("handles large content", () => {
      const large = JSON.stringify({ data: "x".repeat(100_000) });
      const encrypted = encrypt(large, password);
      const decrypted = decrypt(encrypted, password);
      expect(decrypted).toBe(large);
    });
  });

  describe("wrong password", () => {
    it("throws on wrong password", () => {
      const encrypted = encrypt(plaintext, password);
      expect(() => decrypt(encrypted, "wrong-password")).toThrow();
    });

    it("throws on empty password", () => {
      const encrypted = encrypt(plaintext, password);
      expect(() => decrypt(encrypted, "")).toThrow();
    });
  });

  describe("invalid input", () => {
    it("throws on truncated data", () => {
      const encrypted = encrypt(plaintext, password);
      const truncated = encrypted.slice(0, 20);
      expect(() => decrypt(truncated, password)).toThrow();
    });

    it("throws on corrupted data", () => {
      const encrypted = encrypt(plaintext, password);
      // Flip some bytes in the middle
      const buf = Buffer.from(encrypted, "base64");
      buf[buf.length - 5] ^= 0xff;
      const corrupted = buf.toString("base64");
      expect(() => decrypt(corrupted, password)).toThrow();
    });

    it("throws on non-base64 input", () => {
      expect(() => decrypt("not-valid-encrypted-data!!!", password)).toThrow();
    });
  });
});
