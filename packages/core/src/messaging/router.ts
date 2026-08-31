import { istMinuteOfDay, QUIET_START_MIN, QUIET_END_MIN, isoUtc } from "@arbiter/shared";
import type { OutreachChannel, OutreachPayload, OutreachProvider, ProviderDispatchResult } from "./types.js";

export function inQuietHoursIST(nowMs: number): boolean {
  const minute = istMinuteOfDay(nowMs);
  const s = QUIET_START_MIN;
  const e = QUIET_END_MIN;
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}


export class OutreachRouter {
  private providers = new Map<OutreachChannel, OutreachProvider[]>();
  private dndNumbers = new Set<string>();

  /** Register a provider for a channel. First registered acts as primary. */
  registerProvider(provider: OutreachProvider): void {
    const list = this.providers.get(provider.channel) || [];
    list.push(provider);
    this.providers.set(provider.channel, list);
  }

  /** Add a number to local NCPR DND cache */
  addDndNumber(phone: string): void {
    const clean = phone.replace(/[^0-9]/g, "");
    this.dndNumbers.add(clean);
  }

  isDndRegistered(phone?: string): boolean {
    if (!phone) return false;
    const clean = phone.replace(/[^0-9]/g, "");
    return this.dndNumbers.has(clean);
  }

  /** Dispatch an outreach payload to the registered provider for the channel */
  async dispatch(
    channel: OutreachChannel,
    payload: OutreachPayload,
    nowMs: number = Date.now(),
  ): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(nowMs);

    // 1. Regulatory Guardrail: Quiet Hours (22:00 to 08:00 IST)
    // Non-email channels cannot disturb customers at night
    // Bypass with ARBITER_NO_QUIET_HOURS=1 for testing
    if (channel !== "EMAIL" && inQuietHoursIST(nowMs) && !process.env.ARBITER_NO_QUIET_HOURS) {
      console.log(`[Router] SMS suppressed: quiet hours IST (current hour: ${(new Date().getUTCHours() + 5) % 24})`);
      return {
        providerName: "router_guard",
        channel,
        externalMessageId: `suppressed_${payload.proposalId}`,
        status: "SUPPRESSED_QUIET_HOURS",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        errorMessage: "Suppressed due to TRAI quiet hours (22:00 - 08:00 IST). Queued for next morning.",
      };
    }

    // 2. Regulatory Guardrail: NCPR DND Registry
    if ((channel === "SMS" || channel === "VOICE") && this.isDndRegistered(payload.recipient.phone)) {
      return {
        providerName: "dnd_guard",
        channel,
        externalMessageId: `suppressed_dnd_${payload.proposalId}`,
        status: "SUPPRESSED_DND",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        errorMessage: "Suppressed: recipient phone is registered on TRAI NCPR DND registry.",
      };
    }

    const providerList = this.providers.get(channel);
    if (!providerList || providerList.length === 0) {
      return {
        providerName: "none",
        channel,
        externalMessageId: "",
        status: "FAILED",
        costPaise: 0,
        dispatchedAtUtc: nowUtc,
        errorMessage: `No provider registered for channel ${channel}`,
      };
    }

    // Dispatch through primary provider with automatic failover to secondary
    let lastError: Error | null = null;
    for (const provider of providerList) {
      try {
        const result = await provider.send(payload);
        if (result.status === "SENT" || result.status === "DELIVERED" || result.status === "QUEUED") {
          return result;
        }
      } catch (err) {
        lastError = err as Error;
        // Continue to fallback provider
      }
    }

    return {
      providerName: providerList[0]!.name,
      channel,
      externalMessageId: "",
      status: "FAILED",
      costPaise: 0,
      dispatchedAtUtc: nowUtc,
      errorMessage: lastError ? lastError.message : "All providers for channel failed",
    };
  }
}
