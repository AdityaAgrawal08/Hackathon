export function getPublicBaseUrl(overrideUrl?: string): string {
  if (overrideUrl && overrideUrl.trim()) {
    return overrideUrl.trim().replace(/\/$/, "");
  }

  const envUrl = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").trim().replace(/\/$/, "");
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (!envUrl) {
      throw new Error("FATAL: PUBLIC_BASE_URL must be configured in production mode.");
    }
    if (envUrl.includes("localhost") || envUrl.includes("127.0.0.1")) {
      throw new Error("FATAL: PUBLIC_BASE_URL cannot resolve to localhost in production mode.");
    }
    return envUrl;
  }

  if (envUrl) return envUrl;

  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}

export function getMerchantVpa(overrideVpa?: string): string {
  if (overrideVpa && overrideVpa.trim()) {
    return overrideVpa.trim();
  }
  return (process.env.RAZORPAY_MERCHANT_VPA || "merchant@razorpay").trim();
}
