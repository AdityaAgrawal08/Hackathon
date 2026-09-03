/**
 * Automated Tests for Task 6.7 / POL-08: Merchant Recovery Policy Engine
 */
import { describe, it, expect } from "vitest";
import { getMerchantPolicy, upsertMerchantPolicy } from "../../packages/core/src/decide/merchant_policy.js";

describe("Task 6.7 / POL-08: Merchant Recovery Policy Engine (Split-Pay & Grace Rules)", () => {
  it("returns default merchant recovery policy for unconfigured product", async () => {
    const { dbClient } = await import("../../app/server.js");
    const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
    await runMigrations(dbClient);

    const policy = await getMerchantPolicy(dbClient, "prod_unconfigured_xyz");
    expect(policy.allowSplitRecovery).toBe(true);
    expect(policy.minSplitTicketPaise).toBe(199900);
    expect(policy.splitInstallments).toBe(3);
    expect(policy.gracePeriodDays).toBe(3);
    expect(policy.expiryAction).toBe("SOFT_LOCK_FREE_TIER");
  });

  it("upserts custom policy for high-ticket SaaS enterprise tier", async () => {
    const { dbClient } = await import("../../app/server.js");
    const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
    await runMigrations(dbClient);

    const customPolicy = await upsertMerchantPolicy(dbClient, {
      productId: "prod_enterprise_saas",
      allowSplitRecovery: true,
      minSplitTicketPaise: 499900, // ₹4,999
      splitInstallments: 2,
      splitMarkupBps: 300, // 3%
      gracePeriodDays: 7,
      expiryAction: "HALT_CREDIT",
    });

    expect(customPolicy.productId).toBe("prod_enterprise_saas");
    expect(customPolicy.minSplitTicketPaise).toBe(499900);
    expect(customPolicy.splitInstallments).toBe(2);
    expect(customPolicy.gracePeriodDays).toBe(7);
    expect(customPolicy.expiryAction).toBe("HALT_CREDIT");

    // Fetch again from DB
    const fetched = await getMerchantPolicy(dbClient, "prod_enterprise_saas");
    expect(fetched.gracePeriodDays).toBe(7);
    expect(fetched.expiryAction).toBe("HALT_CREDIT");
  });

  it("exposes REST endpoints GET and POST /api/vendor/policies", async () => {
    const { app, dbClient } = await import("../../app/server.js");
    const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
    await runMigrations(dbClient);

    const server = app.listen(0);
    const addr = server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. POST
      const postRes = await fetch(`${baseUrl}/api/vendor/policies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod_custom_api_plan",
          allowSplitRecovery: false,
          minSplitTicketPaise: 999900,
          gracePeriodDays: 5,
        }),
      });
      const postData = await postRes.json() as any;
      expect(postRes.status).toBe(200);
      expect(postData.success).toBe(true);
      expect(postData.policy.allowSplitRecovery).toBe(false);

      // 2. GET
      const getRes = await fetch(`${baseUrl}/api/vendor/policies?productId=prod_custom_api_plan`);
      const getData = await getRes.json() as any;
      expect(getRes.status).toBe(200);
      expect(getData.policy.gracePeriodDays).toBe(5);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
