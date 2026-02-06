/**
 * Pricing Cache
 *
 * Fetches fulaPerGBMonth from pinning-webui on startup and refreshes
 * periodically. Provides a synchronous getter so usdcToFula() stays sync.
 */

import { config } from '../config/index.js';

let cachedRate: number = config.fulaPerGbMonth; // fallback default
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function fetchPricing(): Promise<void> {
  try {
    const res = await fetch(`${config.pinningWebuiUrl}/api/credits/pricing`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { fulaPerGBMonth?: number };
    if (data.fulaPerGBMonth && data.fulaPerGBMonth > 0) {
      cachedRate = data.fulaPerGBMonth;
      console.log(`[pricing] Fetched fulaPerGBMonth=${cachedRate} from pinning-webui`);
    }
  } catch (err) {
    console.warn(
      `[pricing] Failed to fetch pricing, using cached=${cachedRate}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export function getFulaPerGbMonth(): number {
  return cachedRate;
}

export async function initPricingCache(): Promise<void> {
  await fetchPricing();
  refreshTimer = setInterval(fetchPricing, 5 * 60 * 1000); // refresh every 5 min
}

export function stopPricingCache(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
