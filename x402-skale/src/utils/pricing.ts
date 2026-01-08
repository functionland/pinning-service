/**
 * Pricing Utility Functions
 *
 * Calculates payment amounts based on storage size and TTL.
 */

import { config } from '../config/index.js';

/**
 * Calculate price in microUSDC for storage
 *
 * Formula: ceil(size_mb × (ttl_seconds / 3600) × basePriceMicroUsdc)
 *
 * Example: 10MB × 1 hour × $0.01/MB-hour = $0.10 = 100,000 µUSDC
 *
 * @param sizeBytes - File size in bytes
 * @param ttlSeconds - Time-to-live in seconds
 * @returns Price in microUSDC (integer)
 */
export function calculatePriceMicroUsdc(sizeBytes: number, ttlSeconds: number): number {
  const sizeMb = sizeBytes / (1024 * 1024);
  const hours = ttlSeconds / 3600;

  // price = sizeMb × hours × basePriceMicroUsdc
  const price = Math.ceil(sizeMb * hours * config.basePriceMicroUsdc);

  // Enforce minimum payment
  return Math.max(price, config.minPaymentMicroUsdc);
}

/**
 * Calculate price in USDC (human readable)
 *
 * @param sizeBytes - File size in bytes
 * @param ttlSeconds - Time-to-live in seconds
 * @returns Price in USDC (6 decimal places)
 */
export function calculatePriceUsdc(sizeBytes: number, ttlSeconds: number): number {
  const microUsdc = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);
  return microUsdc / 1_000_000;
}

/**
 * Convert microUSDC to USDC
 */
export function microUsdcToUsdc(microUsdc: number): number {
  return microUsdc / 1_000_000;
}

/**
 * Convert USDC to microUSDC
 */
export function usdcToMicroUsdc(usdc: number): number {
  return Math.ceil(usdc * 1_000_000);
}

/**
 * Convert USDC amount to FULA credits
 */
export function usdcToFula(usdc: number): number {
  return usdc * config.fulaExchangeRate;
}

/**
 * Format price for display
 */
export function formatPriceUsdc(microUsdc: number): string {
  const usdc = microUsdc / 1_000_000;
  return `$${usdc.toFixed(6)} USDC`;
}

/**
 * Calculate storage duration from price
 * (Inverse of calculatePriceMicroUsdc)
 *
 * @param sizeBytes - File size in bytes
 * @param microUsdc - Payment amount in microUSDC
 * @returns Duration in seconds
 */
export function calculateDurationFromPrice(sizeBytes: number, microUsdc: number): number {
  const sizeMb = sizeBytes / (1024 * 1024);

  if (sizeMb === 0) {
    return 0;
  }

  // hours = price / (sizeMb × basePriceMicroUsdc)
  const hours = microUsdc / (sizeMb * config.basePriceMicroUsdc);
  return Math.floor(hours * 3600);
}

/**
 * Validate that payment amount is sufficient for the request
 */
export function validatePaymentAmount(
  paidMicroUsdc: number,
  sizeBytes: number,
  ttlSeconds: number
): { valid: boolean; requiredMicroUsdc: number; shortfall: number } {
  const requiredMicroUsdc = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);
  const shortfall = Math.max(0, requiredMicroUsdc - paidMicroUsdc);

  return {
    valid: paidMicroUsdc >= requiredMicroUsdc,
    requiredMicroUsdc,
    shortfall,
  };
}

/**
 * Get pricing info for display/documentation
 */
export function getPricingInfo(): {
  basePricePerMbHour: string;
  minimumPayment: string;
  fulaExchangeRate: number;
  examples: Array<{ size: string; duration: string; price: string }>;
} {
  return {
    basePricePerMbHour: formatPriceUsdc(config.basePriceMicroUsdc),
    minimumPayment: formatPriceUsdc(config.minPaymentMicroUsdc),
    fulaExchangeRate: config.fulaExchangeRate,
    examples: [
      {
        size: '1 MB',
        duration: '1 hour',
        price: formatPriceUsdc(calculatePriceMicroUsdc(1024 * 1024, 3600)),
      },
      {
        size: '10 MB',
        duration: '1 hour',
        price: formatPriceUsdc(calculatePriceMicroUsdc(10 * 1024 * 1024, 3600)),
      },
      {
        size: '100 MB',
        duration: '24 hours',
        price: formatPriceUsdc(calculatePriceMicroUsdc(100 * 1024 * 1024, 86400)),
      },
      {
        size: '1 GB',
        duration: '7 days',
        price: formatPriceUsdc(calculatePriceMicroUsdc(1024 * 1024 * 1024, 604800)),
      },
    ],
  };
}
