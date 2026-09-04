import { describe, it, expect } from "vitest";
import { EnterpriseDataConnector } from "../../packages/core/src/db/enterprise_adapter.js";
import { EnterpriseSelfTrainer } from "../../packages/ml/src/self_trainer.js";

describe("Enterprise Plug-and-Play Database Connector & Self-Trainer", () => {
  it("discovers schema accurately from external enterprise column naming conventions", () => {
    const rawEnterpriseRows = [
      {
        order_number: "ORD_789123",
        client_guid: "user_alpha_99",
        full_name: "Vikram Mehta",
        mail_address: "vikram@example.com",
        contact_number: "+919876543210",
        order_total: 2499, // in rupees
        payment_mode: "credit_card",
        payment_status: "failed",
        err_code: "GATEWAY_TIMEOUT",
        err_desc: "Issuer bank timed out",
        order_date: "2026-08-15T10:30:00.000Z",
      },
    ];

    const mapping = EnterpriseDataConnector.discoverSchema(rawEnterpriseRows);
    expect(mapping.orderIdCol).toBe("order_number");
    expect(mapping.customerIdCol).toBe("client_guid");
    expect(mapping.customerNameCol).toBe("full_name");
    expect(mapping.customerEmailCol).toBe("mail_address");
    expect(mapping.customerPhoneCol).toBe("contact_number");
    expect(mapping.amountCol).toBe("order_total");
    expect(mapping.amountUnit).toBe("rupees");
    expect(mapping.paymentMethodCol).toBe("payment_mode");
    expect(mapping.statusCol).toBe("payment_status");
    expect(mapping.failureCodeCol).toBe("err_code");
    expect(mapping.failureReasonCol).toBe("err_desc");
  });

  it("normalizes arbitrary enterprise rows into canonical payment records without DB changes", () => {
    const rawRows = [
      {
        order_number: "ORD_101",
        client_guid: "usr_101",
        full_name: "Sneha Roy",
        mail_address: "sneha@example.com",
        contact_number: "+919876543211",
        order_total: 1500, // Rs 1500 -> 150000 paise
        payment_mode: "visa_card",
        payment_status: "failed",
        err_code: "INSUFFICIENT_FUNDS",
        err_desc: "Card declined by issuer",
        order_date: "2026-08-15T12:00:00.000Z",
      },
    ];

    const records = EnterpriseDataConnector.extractHistoricalBatch(rawRows);
    expect(records).toHaveLength(1);
    const rec = records[0]!;

    expect(rec.orderId).toBe("ORD_101");
    expect(rec.customerId).toBe("usr_101");
    expect(rec.customerName).toBe("Sneha Roy");
    expect(rec.customerEmail).toBe("sneha@example.com");
    expect(rec.amountPaise).toBe(150000);
    expect(rec.paymentMethod).toBe("card");
    expect(rec.status).toBe("failed");
    expect(rec.failureCode).toBe("INSUFFICIENT_FUNDS");
  });

  it("extracts empirical priors and warm-starts contextual bandit from historical batches", () => {
    const historicalRecords = [
      {
        orderId: "ORD_1",
        customerId: "CUST_1",
        customerName: "Rahul",
        customerEmail: "rahul@example.com",
        customerPhone: "+919800000001",
        amountPaise: 100000,
        paymentMethod: "card" as const,
        status: "captured" as const,
        timestamp: new Date("2026-08-01T10:00:00Z"),
        recoveredAt: new Date("2026-08-01T10:15:00Z"),
        recoveredMethod: "upi",
      },
      {
        orderId: "ORD_2",
        customerId: "CUST_2",
        customerName: "Priya",
        customerEmail: "priya@example.com",
        customerPhone: "+919800000002",
        amountPaise: 50000,
        paymentMethod: "card" as const,
        status: "failed" as const,
        timestamp: new Date("2026-08-01T11:00:00Z"),
      },
      {
        orderId: "ORD_3",
        customerId: "CUST_3",
        customerName: "Amit",
        customerEmail: "amit@example.com",
        customerPhone: "+919800000003",
        amountPaise: 75000,
        paymentMethod: "netbanking" as const,
        status: "captured" as const,
        timestamp: new Date("2026-08-01T12:00:00Z"),
        recoveredAt: new Date("2026-08-01T12:20:00Z"),
        recoveredMethod: "upi",
      },
    ];

    const summary = EnterpriseSelfTrainer.analyzeHistoricalBatch(historicalRecords);
    expect(summary.totalTransactions).toBe(3);
    expect(summary.failedCount).toBe(1);
    expect(summary.recoveredCount).toBe(2);
    expect(summary.latencyStats.medianTurnaroundMinutes).toBeGreaterThan(0);
    expect(summary.calibratedArmPriors.ONE_TAP_UPI).toBeDefined();
    expect(summary.calibratedArmPriors.ONE_TAP_UPI!.baselineScore).toBeGreaterThan(0.5);
  });
});
