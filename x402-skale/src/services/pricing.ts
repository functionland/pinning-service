/**
 * Pricing Service
 *
 * Provides pricing information and calculations.
 * Re-exports utilities for convenience.
 */

import { config } from '../config/index.js';
import {
  calculatePriceMicroUsdc,
  calculatePriceUsdc,
  microUsdcToUsdc,
  usdcToMicroUsdc,
  usdcToFula,
  formatPriceUsdc,
  calculateDurationFromPrice,
  validatePaymentAmount,
  getPricingInfo,
} from '../utils/pricing.js';

// Re-export all pricing utilities
export {
  calculatePriceMicroUsdc,
  calculatePriceUsdc,
  microUsdcToUsdc,
  usdcToMicroUsdc,
  usdcToFula,
  formatPriceUsdc,
  calculateDurationFromPrice,
  validatePaymentAmount,
  getPricingInfo,
};

/**
 * Get pricing configuration
 */
export function getPricingConfig(): {
  basePriceMicroUsdc: number;
  basePriceUsdc: number;
  minPaymentMicroUsdc: number;
  minPaymentUsdc: number;
  fulaExchangeRate: number;
  network: string;
  tokenAddress: string;
  tokenName: string;
} {
  return {
    basePriceMicroUsdc: config.basePriceMicroUsdc,
    basePriceUsdc: config.basePriceMicroUsdc / 1_000_000,
    minPaymentMicroUsdc: config.minPaymentMicroUsdc,
    minPaymentUsdc: config.minPaymentMicroUsdc / 1_000_000,
    fulaExchangeRate: config.fulaExchangeRate,
    network: `eip155:${config.networkChainId}`,
    tokenAddress: config.paymentTokenAddress,
    tokenName: config.paymentTokenName,
  };
}

/**
 * Calculate quote for a storage request
 */
export function getStorageQuote(sizeBytes: number, ttlSeconds: number): {
  sizeBytes: number;
  sizeMb: number;
  ttlSeconds: number;
  ttlHours: number;
  priceMicroUsdc: number;
  priceUsdc: number;
  priceFormatted: string;
  fulaCredits: number;
} {
  const sizeMb = sizeBytes / (1024 * 1024);
  const ttlHours = ttlSeconds / 3600;
  const priceMicroUsdc = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);
  const priceUsdc = microUsdcToUsdc(priceMicroUsdc);

  return {
    sizeBytes,
    sizeMb,
    ttlSeconds,
    ttlHours,
    priceMicroUsdc,
    priceUsdc,
    priceFormatted: formatPriceUsdc(priceMicroUsdc),
    fulaCredits: usdcToFula(priceUsdc),
  };
}

export default {
  getPricingConfig,
  getPricingInfo,
  getStorageQuote,
  calculatePriceMicroUsdc,
  calculatePriceUsdc,
  validatePaymentAmount,
};
