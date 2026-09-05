import { getBankHealth } from "../ingest/rail_health.js";

export interface RailSteeringRequest {
  customerVpa?: string;
  issuerBank?: string;
  cardBin?: string;
  method?: "upi" | "card" | "netbanking";
  amountPaise: number;
}

export interface RailSteeringDecision {
  steered: boolean;
  originalRail: string;
  degradedReason?: string;
  recommendedRail?: string;
  suggestedVpa?: string;
  fallbackOptions?: string[];
  userMessage?: string;
}

const UPI_HANDLE_TO_BANK: Record<string, string> = {
  okhdfcbank: "HDFC",
  hdfcbank: "HDFC",
  okaxis: "AXIS",
  axisbank: "AXIS",
  okicici: "ICICI",
  icici: "ICICI",
  ibl: "ICICI",
  oksbi: "SBI",
  sbi: "SBI",
  ybl: "YESBANK",
  paytm: "PAYTM",
  kotak: "KOTAK",
};

const BANK_TO_HEALTHY_HANDLE: Record<string, string> = {
  AXIS: "okaxis",
  ICICI: "okicici",
  SBI: "oksbi",
  YESBANK: "ybl",
};

export function extractBankFromVpa(vpa: string): string | null {
  if (!vpa || !vpa.includes("@")) return null;
  const parts = vpa.trim().toLowerCase().split("@");
  const handle = parts[1];
  if (!handle) return null;
  return UPI_HANDLE_TO_BANK[handle] || null;
}

export function extractBankFromBin(bin: string): string | null {
  if (!bin) return null;
  const cleanBin = bin.replace(/\D/g, "").slice(0, 6);
  if (cleanBin.startsWith("411111") || cleanBin.startsWith("421111")) return "HDFC";
  if (cleanBin.startsWith("438628") || cleanBin.startsWith("405501")) return "ICICI";
  if (cleanBin.startsWith("524164") || cleanBin.startsWith("607152")) return "AXIS";
  if (cleanBin.startsWith("401200") || cleanBin.startsWith("504435")) return "SBI";
  return null;
}

export function steerCustomerVpa(vpa: string, targetBank: "AXIS" | "ICICI" | "SBI" = "AXIS"): string {
  if (!vpa || !vpa.includes("@")) return vpa;
  const username = vpa.split("@")[0];
  const newHandle = BANK_TO_HEALTHY_HANDLE[targetBank] || "okaxis";
  return `${username}@${newHandle}`;
}

export function evaluatePreFlightSteering(request: RailSteeringRequest): RailSteeringDecision {
  let detectedBank: string | null = null;

  if (request.customerVpa) {
    detectedBank = extractBankFromVpa(request.customerVpa);
  } else if (request.cardBin) {
    detectedBank = extractBankFromBin(request.cardBin);
  } else if (request.issuerBank) {
    detectedBank = request.issuerBank.trim().toUpperCase();
  }

  if (!detectedBank) {
    return {
      steered: false,
      originalRail: request.method || "UNKNOWN",
    };
  }

  const bankHealth = getBankHealth(detectedBank);

  if (bankHealth.degraded) {
    const recommendedBank = detectedBank === "AXIS" ? "ICICI" : "AXIS";
    const suggestedVpa = request.customerVpa ? steerCustomerVpa(request.customerVpa, recommendedBank as any) : undefined;

    return {
      steered: true,
      originalRail: detectedBank,
      degradedReason: `${detectedBank} switch is currently degraded (${bankHealth.status}). Routing pre-attempt to healthy switch.`,
      recommendedRail: recommendedBank,
      suggestedVpa,
      fallbackOptions: [
        `UPI_${recommendedBank}`,
        "UPI_ICICI",
        "NETBANKING_HEALTHY",
      ],
      userMessage: `${detectedBank} servers are experiencing high downtime. Switched automatically to ${recommendedBank} to ensure instant zero-drop completion.`,
    };
  }

  return {
    steered: false,
    originalRail: detectedBank,
  };
}
