/**
 * Enterprise Plug-and-Play Database Connector & Semantic Schema Adapter
 *
 * Enables ARBITER to connect to an enterprise's existing massive data warehouse
 * (PostgreSQL, MySQL, Snowflake, BigQuery, SQLite) as a non-invasive read-only sidecar.
 *
 * Automatically inspects column names across disparate company schemas and normalizes
 * arbitrary payment/order rows into canonical payment records without requiring
 * any schema migrations on the enterprise database.
 */

export interface CanonicalPaymentRecord {
  orderId: string;
  paymentId?: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  amountPaise: number;
  paymentMethod: "upi" | "card" | "netbanking" | "wallet" | "other";
  status: "failed" | "captured" | "pending" | "refunded";
  failureCode?: string;
  failureReason?: string;
  timestamp: Date;
  recoveredAt?: Date;
  recoveredMethod?: string;
}

export interface SchemaMapping {
  orderIdCol: string;
  paymentIdCol?: string;
  customerIdCol: string;
  customerNameCol?: string;
  customerEmailCol?: string;
  customerPhoneCol?: string;
  amountCol: string;
  amountUnit: "paise" | "rupees";
  paymentMethodCol?: string;
  statusCol: string;
  failureCodeCol?: string;
  failureReasonCol?: string;
  timestampCol: string;
  recoveredAtCol?: string;
}

export class EnterpriseDataConnector {
  /**
   * Introspects sample rows from an existing enterprise table and automatically
   * resolves column semantics (e.g. `client_guid` -> customerId, `order_total` -> amount).
   */
  static discoverSchema(sampleRows: Record<string, any>[]): SchemaMapping {
    if (!sampleRows || sampleRows.length === 0) {
      throw new Error("Cannot discover schema from empty sample dataset");
    }

    const firstRow = sampleRows[0];
    if (!firstRow) {
      throw new Error("Cannot discover schema from empty sample dataset");
    }
    const columns = Object.keys(firstRow);

    const findMatch = (patterns: RegExp[]): string | undefined => {
      for (const pat of patterns) {
        const found = columns.find((c) => pat.test(c));
        if (found) return found;
      }
      return undefined;
    };

    // 1. Order ID resolution
    const orderIdCol = findMatch([
      /^(order_id|orderid|order_number|invoice_id|booking_id|transaction_id|txn_id)$/i,
      /order.*id/i,
      /^id$/i,
    ]) || "id";

    // 2. Customer ID resolution
    const customerIdCol = findMatch([
      /^(customer_id|cust_id|user_id|userid|client_id|client_guid|account_id|customer_guid|buyer_id)$/i,
      /(customer|cust|user|client|account|buyer)_(id|guid|key|pk)/i,
      /cust.*id/i,
      /user.*id/i,
      /client.*(id|guid)/i,
    ]) || "customer_id";

    // 3. Amount resolution & currency unit detection
    const amountCol = findMatch([
      /^(amount_paise|amount|total|order_total|grand_total|price|ticket_size|value)$/i,
      /amount/i,
      /total/i,
    ]) || "amount";

    // Sample amount values to determine if amounts are stored in paise or rupees
    let isPaise = false;
    if (amountCol.toLowerCase().includes("paise")) {
      isPaise = true;
    } else {
      const sampleAmounts = sampleRows
        .map((r) => Number(r[amountCol]))
        .filter((n) => !isNaN(n) && n > 0);
      const avg = sampleAmounts.length > 0 ? sampleAmounts.reduce((a, b) => a + b, 0) / sampleAmounts.length : 0;
      // In Indian e-commerce, average ticket in paise is typically > 10,000 (>= ₹100)
      if (avg >= 10000 && sampleAmounts.every((n) => Number.isInteger(n) && n % 100 === 0)) {
        isPaise = true;
      }
    }

    // 4. Status resolution
    const statusCol = findMatch([
      /^(payment_status|order_status|status|state|txn_state)$/i,
      /status/i,
    ]) || "status";

    // 5. Failure code & reason resolution
    const failureCodeCol = findMatch([
      /^(failure_code|error_code|err_code|decline_code|gateway_code|error_reason)$/i,
      /err.*code/i,
      /fail.*code/i,
    ]);

    const failureReasonCol = findMatch([
      /^(failure_reason|error_description|err_desc|error_message|decline_reason)$/i,
      /reason/i,
      /desc/i,
    ]);

    // 6. Contact info resolution
    const customerNameCol = findMatch([
      /^(customer_name|cust_name|user_name|name|full_name|buyer_name)$/i,
      /name/i,
    ]);

    const customerEmailCol = findMatch([
      /^(customer_email|cust_email|user_email|email|mail_address)$/i,
      /email/i,
    ]);

    const customerPhoneCol = findMatch([
      /^(customer_phone|cust_phone|user_phone|phone|mobile|contact|contact_number)$/i,
      /phone/i,
      /mobile/i,
    ]);

    // 7. Payment method resolution
    const paymentMethodCol = findMatch([
      /^(payment_method|pay_method|method|instrument|payment_mode|channel)$/i,
      /method/i,
      /mode/i,
    ]);

    // 8. Timestamp resolution
    const timestampCol = findMatch([
      /^(created_at|created_at_utc|timestamp|txn_date|created_date|order_date)$/i,
      /time/i,
      /date/i,
    ]) || "created_at";

    return {
      orderIdCol,
      paymentIdCol: findMatch([/^(payment_id|razorpay_payment_id|gateway_payment_id)$/i]),
      customerIdCol,
      customerNameCol,
      customerEmailCol,
      customerPhoneCol,
      amountCol,
      amountUnit: isPaise ? "paise" : "rupees",
      paymentMethodCol,
      statusCol,
      failureCodeCol,
      failureReasonCol,
      timestampCol,
      recoveredAtCol: findMatch([/^(recovered_at|settled_at|paid_at)$/i]),
    };
  }

  /**
   * Transforms an arbitrary enterprise row into a canonical payment entity.
   */
  static normalizeRow(row: Record<string, any>, mapping: SchemaMapping): CanonicalPaymentRecord {
    const rawAmount = Number(row[mapping.amountCol] || 0);
    const amountPaise = mapping.amountUnit === "paise" ? Math.round(rawAmount) : Math.round(rawAmount * 100);

    const rawStatus = String(row[mapping.statusCol] || "").toLowerCase();
    let status: CanonicalPaymentRecord["status"] = "pending";
    if (rawStatus.includes("fail") || rawStatus.includes("decline") || rawStatus.includes("error")) {
      status = "failed";
    } else if (rawStatus.includes("cap") || rawStatus.includes("paid") || rawStatus.includes("succ") || rawStatus.includes("settl")) {
      status = "captured";
    } else if (rawStatus.includes("ref")) {
      status = "refunded";
    }

    const rawMethod = String(mapping.paymentMethodCol ? row[mapping.paymentMethodCol] || "" : "").toLowerCase();
    let paymentMethod: CanonicalPaymentRecord["paymentMethod"] = "other";
    if (rawMethod.includes("upi") || rawMethod.includes("gpay") || rawMethod.includes("phonepe") || rawMethod.includes("paytm")) {
      paymentMethod = "upi";
    } else if (rawMethod.includes("card") || rawMethod.includes("credit") || rawMethod.includes("debit") || rawMethod.includes("visa") || rawMethod.includes("master")) {
      paymentMethod = "card";
    } else if (rawMethod.includes("net") || rawMethod.includes("bank") || rawMethod.includes("nb")) {
      paymentMethod = "netbanking";
    } else if (rawMethod.includes("wallet")) {
      paymentMethod = "wallet";
    }

    const rawTime = row[mapping.timestampCol];
    const timestamp = rawTime ? new Date(rawTime) : new Date();

    return {
      orderId: String(row[mapping.orderIdCol] || ""),
      paymentId: mapping.paymentIdCol ? String(row[mapping.paymentIdCol] || "") : undefined,
      customerId: String(row[mapping.customerIdCol] || ""),
      customerName: mapping.customerNameCol ? String(row[mapping.customerNameCol] || "Customer") : "Customer",
      customerEmail: mapping.customerEmailCol ? String(row[mapping.customerEmailCol] || "") : "",
      customerPhone: mapping.customerPhoneCol ? String(row[mapping.customerPhoneCol] || "") : "",
      amountPaise,
      paymentMethod,
      status,
      failureCode: mapping.failureCodeCol ? String(row[mapping.failureCodeCol] || "") : undefined,
      failureReason: mapping.failureReasonCol ? String(row[mapping.failureReasonCol] || "") : undefined,
      timestamp,
      recoveredAt: mapping.recoveredAtCol && row[mapping.recoveredAtCol] ? new Date(row[mapping.recoveredAtCol]) : undefined,
    };
  }

  /**
   * Normalizes an entire historical batch extracted from an enterprise data warehouse.
   */
  static extractHistoricalBatch(rows: Record<string, any>[], customMapping?: SchemaMapping): CanonicalPaymentRecord[] {
    const mapping = customMapping || this.discoverSchema(rows);
    return rows.map((r) => this.normalizeRow(r, mapping));
  }
}
