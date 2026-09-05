/**
 * Specialized Test Suite: CSV Batch Failure Log Ingestion & Independent Non-Circular Ablation Benchmark (FIX-036)
 */
import { describe, it, expect } from "vitest";
import { parseRazorpayFailureCsv, evaluateCsvFailureRecords } from "../../packages/core/src/decide/ablation_benchmark.js";

const SAMPLE_CSV = `Payment ID,Order ID,Amount,Currency,Status,Failure Code,Failure Description,Payment Method,Created At,Customer Email,Customer Phone
pay_sample_001,order_001,1500.00,INR,failed,BAD_REQUEST_ERROR,"Payment failed due to customer entering wrong UPI PIN",upi,2026-03-01 10:00:00,user1@example.com,+919876543210
pay_sample_002,order_002,2999.00,INR,failed,GATEWAY_ERROR,"Bank gateway timed out during processing",card,2026-03-01 10:05:00,user2@example.com,+919876543211
pay_sample_003,order_003,450.00,INR,failed,INSUFFICIENT_FUNDS,"Insufficient funds in account",upi,2026-03-01 10:10:00,user3@example.com,+919876543212
pay_sample_004,order_004,12000.00,INR,failed,CARD_EXPIRED,"Card validity expired",card,2026-03-01 10:15:00,user4@example.com,+919876543213
pay_sample_005,order_005,999.00,INR,failed,PAYMENT_CANCELLED,"Customer dropped off at OTP screen",card,2026-03-01 10:20:00,user5@example.com,+919876543214
`;

describe("FIX-036: CSV Batch Failure Ingestion & Non-Circular Benchmark", () => {
  it("parses standard Razorpay payment failure CSV adhering to RFC 4180", () => {
    const records = parseRazorpayFailureCsv(SAMPLE_CSV);
    expect(records.length).toBe(5);

    expect(records[0].paymentId).toBe("pay_sample_001");
    expect(records[0].amountPaise).toBe(150000);
    expect(records[0].failureCategory).toBe("USER_ACTIONABLE");
    expect(records[0].isCard).toBe(false);

    expect(records[1].paymentId).toBe("pay_sample_002");
    expect(records[1].amountPaise).toBe(299900);
    expect(records[1].failureCategory).toBe("TECHNICAL");
    expect(records[1].isCard).toBe(true);

    expect(records[2].failureCategory).toBe("LIQUIDITY");
    expect(records[3].failureCategory).toBe("EXPIRED_METHOD");
  });

  it("handles messy CSV inputs with extra whitespace, commas inside quotes, and header variations", () => {
    const messyCsv = `  "payment_id" , "order_id" , "amount_inr" , "error_code" , "error_description" , "method" 
"pay_messy_1","order_m1","2,500.50","PAYMENT_GATEWAY_TIMEOUT","Timeout at HDFC switch, please retry","card"
"pay_messy_2","order_m2","100","CUSTOMER_DROPPED","User exited without paying","upi"
`;
    const records = parseRazorpayFailureCsv(messyCsv);
    expect(records.length).toBe(2);
    expect(records[0].paymentId).toBe("pay_messy_1");
    expect(records[0].amountPaise).toBe(250050);
    expect(records[0].isCard).toBe(true);
    expect(records[1].paymentId).toBe("pay_messy_2");
    expect(records[1].amountPaise).toBe(10000);
  });

  it("evaluates CSV failure records across all 4 independent benchmark arms", () => {
    const report = evaluateCsvFailureRecords(SAMPLE_CSV, { seed: 0x42 });

    expect(report.batchSize).toBe(5);
    expect(report.domain).toBe("csv_upload");
    expect(report.totalAtRiskPaise).toBe(150000 + 299900 + 45000 + 1200000 + 99900);

    const { control, blindRetries, staticRules, arbiter } = report.arms;

    // Verify all arms exist and have expected structure
    expect(control.armId).toBe("ARM_0_CONTROL");
    expect(blindRetries.armId).toBe("ARM_1_BLIND_RETRIES");
    expect(staticRules.armId).toBe("ARM_2_STATIC_RULES");
    expect(arbiter.armId).toBe("ARM_3_ARBITER");

    // Arms have non-negative recovered amounts bounded by total at risk
    expect(arbiter.recoveredPaise).toBeLessThanOrEqual(report.totalAtRiskPaise);
    expect(control.totalCostPaise).toBe(0);
    expect(arbiter.mdrSavingsPaise).toBeGreaterThanOrEqual(0);

    // Bootstrap confidence intervals are computed
    expect(arbiter.ci95LowPercent).toBeDefined();
    expect(arbiter.ci95HighPercent).toBeDefined();
  });

  it("throws clear error when CSV has no valid records or is completely empty", () => {
    expect(() => evaluateCsvFailureRecords("")).toThrow("No valid payment failure records found in CSV.");
    expect(() => evaluateCsvFailureRecords("col1,col2,col3\n,,")).toThrow("No valid payment failure records found in CSV.");
  });

  it("POST /api/benchmark/upload-csv returns 4-way evaluation report over HTTP API", async () => {
    const { app } = await import("../../app/server.js");
    const server = app.listen(0);
    const addr = server.address() as any;

    try {
      // Test JSON payload { csv: "..." }
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/benchmark/upload-csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: SAMPLE_CSV }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.report).toBeDefined();
      expect(data.report.batchSize).toBe(5);
      expect(data.report.arms.arbiter).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
