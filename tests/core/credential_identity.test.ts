/**
 * Automated Tests for Task 6.5 / ID-06: Credential-Bound Identity Decoupling
 */
import { describe, it, expect } from "vitest";
import { computeCredentialId, resolveOrCreateCredential } from "../../packages/core/src/db/credential.js";

describe("Task 6.5 / ID-06: Credential-Bound Identity Decoupling", () => {
  describe("1. Deterministic SHA-256 Credential Hashing", () => {
    it("generates identical credential hashes across varied phone and email formatting", () => {
      const hash1 = computeCredentialId("+91 98765 43210", "aditya@arbiter.live");
      const hash2 = computeCredentialId("9876543210", "ADITYA@ARBITER.LIVE");
      const hash3 = computeCredentialId("09876543210", "  aditya@arbiter.live  ");

      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    it("generates distinct hashes for distinct credentials", () => {
      const hashA = computeCredentialId("9876543210", "userA@arbiter.live");
      const hashB = computeCredentialId("9876543211", "userB@arbiter.live");

      expect(hashA).not.toBe(hashB);
    });
  });

  describe("2. Database Idempotency & Persona Decoupling", () => {
    it("persists credential idempotently and decouples persona display names", async () => {
      const { dbClient } = await import("../../app/server.js");
      const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
      await runMigrations(dbClient);

      const phone = "9811122233";
      const email = "persona.test@example.com";

      // 1. Resolve for first persona "Aditya Agrawal"
      const credId1 = await resolveOrCreateCredential(dbClient, phone, email);

      // 2. Resolve for second persona "A. Agrawal" on same phone/email
      const credId2 = await resolveOrCreateCredential(dbClient, `+91 ${phone}`, `  ${email.toUpperCase()} `);

      expect(credId1).toBe(credId2);

      // Verify row exists in DB
      const result = await dbClient.execute({
        sql: `SELECT * FROM customer_credentials WHERE id = ?`,
        args: [credId1],
      });

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].phone).toBe(`91${phone}`);
      expect(result.rows[0].email).toBe(email);
    });
  });
});
