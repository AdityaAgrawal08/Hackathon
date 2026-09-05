import { isoUtc } from "@arbiter/shared";
import type { OutreachChannel, OutreachPayload, OutreachProvider, ProviderDispatchResult } from "./types.js";


export class OutreachRouter {
  private providers = new Map<OutreachChannel, OutreachProvider[]>();
  private dndNumbers = new Set<string>();
  private inFlightDispatches = 0;
  private readonly maxConcurrentDispatches: number;
  private pendingQueue: Array<() => void> = [];

  constructor(options?: { maxConcurrentDispatches?: number }) {
    this.maxConcurrentDispatches = options?.maxConcurrentDispatches ?? 25;
  }

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

  getConcurrencyStats(): { inFlight: number; queued: number; maxConcurrent: number } {
    return {
      inFlight: this.inFlightDispatches,
      queued: this.pendingQueue.length,
      maxConcurrent: this.maxConcurrentDispatches,
    };
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlightDispatches < this.maxConcurrentDispatches) {
      this.inFlightDispatches++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.pendingQueue.push(() => {
        this.inFlightDispatches++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inFlightDispatches = Math.max(0, this.inFlightDispatches - 1);
    const next = this.pendingQueue.shift();
    if (next) {
      next();
    }
  }

  /** Dispatch an outreach payload to the registered provider for the channel */
  async dispatch(
    channel: OutreachChannel,
    payload: OutreachPayload,
    nowMs: number = Date.now(),
  ): Promise<ProviderDispatchResult> {
    const nowUtc = isoUtc(nowMs);

    // 1. Regulatory Guardrail: NCPR DND Registry
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

    // Acquire concurrency slot to protect socket exhaustion during batch spikes
    await this.acquireSlot();
    try {
      // Dispatch through primary provider with automatic failover to secondary
      let lastError: Error | null = null;
      let lastFailedResult: ProviderDispatchResult | null = null;
      for (const provider of providerList) {
        try {
          const result = await provider.send(payload);
          if (result.status === "SENT" || result.status === "DELIVERED" || result.status === "QUEUED") {
            return result;
          }
          lastFailedResult = result;
        } catch (err) {
          lastError = err as Error;
          // Continue to fallback provider
        }
      }

      if (lastFailedResult) {
        return lastFailedResult;
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
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Multi-rail cascade:
   * If primary channel is SMS, tries registered SMS providers (MSG91 -> Brevo SMS).
   * If SMS is suppressed by DND or all SMS providers fail, automatically cascades to EMAIL (Brevo Email).
   */
  async dispatchWithCascade(
    preferredChannel: OutreachChannel,
    payload: OutreachPayload,
    nowMs: number = Date.now(),
  ): Promise<ProviderDispatchResult & { cascadedFrom?: OutreachChannel }> {
    const primaryResult = await this.dispatch(preferredChannel, payload, nowMs);
    if (primaryResult.status === "SENT" || primaryResult.status === "DELIVERED" || primaryResult.status === "QUEUED") {
      return primaryResult;
    }

    // If preferred was SMS and failed or was suppressed by DND, cascade to EMAIL
    if (preferredChannel === "SMS" && this.providers.has("EMAIL")) {
      const emailResult = await this.dispatch("EMAIL", payload, nowMs);
      return {
        ...emailResult,
        cascadedFrom: "SMS",
      };
    }

    return primaryResult;
  }
}
