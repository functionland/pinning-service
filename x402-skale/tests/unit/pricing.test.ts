/**
 * Unit Tests for Pricing Utilities
 *
 * Tests pricing calculations and USDC conversions.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock config before importing pricing module
vi.mock('../../src/config/index.js', () => ({
  config: {
    basePriceMicroUsdc: 10000,  // $0.01 per MB-hour
    minPaymentMicroUsdc: 1000,  // $0.001 minimum
    fulaExchangeRate: 1.0,
  },
}));

// Import after mocking
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
} from '../../src/utils/pricing.js';

describe('Pricing Utilities', () => {
  describe('calculatePriceMicroUsdc', () => {
    it('should calculate price for 1 MB for 1 hour', () => {
      const sizeBytes = 1 * 1024 * 1024; // 1 MB
      const ttlSeconds = 3600; // 1 hour

      const price = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);

      // 1 MB × 1 hour × $0.01 = $0.01 = 10000 µUSDC
      expect(price).toBe(10000);
    });

    it('should calculate price for 10 MB for 1 hour', () => {
      const sizeBytes = 10 * 1024 * 1024; // 10 MB
      const ttlSeconds = 3600; // 1 hour

      const price = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);

      // 10 MB × 1 hour × $0.01 = $0.10 = 100000 µUSDC
      expect(price).toBe(100000);
    });

    it('should calculate price for 100 MB for 24 hours', () => {
      const sizeBytes = 100 * 1024 * 1024; // 100 MB
      const ttlSeconds = 24 * 3600; // 24 hours

      const price = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);

      // 100 MB × 24 hours × $0.01 = $24.00 = 24000000 µUSDC
      expect(price).toBe(24000000);
    });

    it('should enforce minimum payment', () => {
      const sizeBytes = 100; // 0.0001 MB - very small file
      const ttlSeconds = 60; // 1 minute

      const price = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);

      // Price would be ~0.16 µUSDC, but minimum is 1000
      expect(price).toBe(1000);
    });

    it('should round up fractional prices', () => {
      const sizeBytes = 1.5 * 1024 * 1024; // 1.5 MB
      const ttlSeconds = 3600; // 1 hour

      const price = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);

      // 1.5 MB × 1 hour × $0.01 = 15000 µUSDC (ceil)
      expect(price).toBe(15000);
    });

    it('should handle zero size', () => {
      const price = calculatePriceMicroUsdc(0, 3600);
      expect(price).toBe(1000); // Minimum
    });

    it('should handle zero TTL', () => {
      const price = calculatePriceMicroUsdc(1024 * 1024, 0);
      expect(price).toBe(1000); // Minimum
    });
  });

  describe('calculatePriceUsdc', () => {
    it('should convert microUSDC to USDC', () => {
      const sizeBytes = 10 * 1024 * 1024; // 10 MB
      const ttlSeconds = 3600; // 1 hour

      const price = calculatePriceUsdc(sizeBytes, ttlSeconds);

      // 100000 µUSDC = $0.10 USDC
      expect(price).toBe(0.1);
    });
  });

  describe('microUsdcToUsdc', () => {
    it('should convert 1000000 µUSDC to 1 USDC', () => {
      expect(microUsdcToUsdc(1000000)).toBe(1);
    });

    it('should convert 10000 µUSDC to 0.01 USDC', () => {
      expect(microUsdcToUsdc(10000)).toBe(0.01);
    });

    it('should handle zero', () => {
      expect(microUsdcToUsdc(0)).toBe(0);
    });
  });

  describe('usdcToMicroUsdc', () => {
    it('should convert 1 USDC to 1000000 µUSDC', () => {
      expect(usdcToMicroUsdc(1)).toBe(1000000);
    });

    it('should convert 0.01 USDC to 10000 µUSDC', () => {
      expect(usdcToMicroUsdc(0.01)).toBe(10000);
    });

    it('should round up fractional values', () => {
      expect(usdcToMicroUsdc(0.0000001)).toBe(1);
    });
  });

  describe('usdcToFula', () => {
    it('should convert USDC to FULA at 1:1 rate', () => {
      expect(usdcToFula(1)).toBe(1);
      expect(usdcToFula(10)).toBe(10);
      expect(usdcToFula(0.01)).toBe(0.01);
    });
  });

  describe('formatPriceUsdc', () => {
    it('should format microUSDC as USDC string', () => {
      expect(formatPriceUsdc(1000000)).toBe('$1.000000 USDC');
      expect(formatPriceUsdc(10000)).toBe('$0.010000 USDC');
      expect(formatPriceUsdc(1000)).toBe('$0.001000 USDC');
    });
  });

  describe('calculateDurationFromPrice', () => {
    it('should calculate duration from price', () => {
      const sizeBytes = 10 * 1024 * 1024; // 10 MB
      const microUsdc = 100000; // $0.10

      const duration = calculateDurationFromPrice(sizeBytes, microUsdc);

      // $0.10 / (10 MB × $0.01) = 1 hour = 3600 seconds
      expect(duration).toBe(3600);
    });

    it('should handle zero size gracefully', () => {
      const duration = calculateDurationFromPrice(0, 100000);
      expect(duration).toBe(0);
    });
  });

  describe('validatePaymentAmount', () => {
    it('should validate sufficient payment', () => {
      const sizeBytes = 10 * 1024 * 1024; // 10 MB
      const ttlSeconds = 3600; // 1 hour
      const paidMicroUsdc = 100000; // $0.10

      const result = validatePaymentAmount(paidMicroUsdc, sizeBytes, ttlSeconds);

      expect(result.valid).toBe(true);
      expect(result.requiredMicroUsdc).toBe(100000);
      expect(result.shortfall).toBe(0);
    });

    it('should detect insufficient payment', () => {
      const sizeBytes = 10 * 1024 * 1024; // 10 MB
      const ttlSeconds = 3600; // 1 hour
      const paidMicroUsdc = 50000; // $0.05

      const result = validatePaymentAmount(paidMicroUsdc, sizeBytes, ttlSeconds);

      expect(result.valid).toBe(false);
      expect(result.requiredMicroUsdc).toBe(100000);
      expect(result.shortfall).toBe(50000);
    });

    it('should accept overpayment', () => {
      const sizeBytes = 10 * 1024 * 1024; // 10 MB
      const ttlSeconds = 3600; // 1 hour
      const paidMicroUsdc = 200000; // $0.20

      const result = validatePaymentAmount(paidMicroUsdc, sizeBytes, ttlSeconds);

      expect(result.valid).toBe(true);
      expect(result.shortfall).toBe(0);
    });
  });

  describe('getPricingInfo', () => {
    it('should return pricing information', () => {
      const info = getPricingInfo();

      expect(info.basePricePerMbHour).toBe('$0.010000 USDC');
      expect(info.minimumPayment).toBe('$0.001000 USDC');
      expect(info.fulaExchangeRate).toBe(1.0);
      expect(info.examples).toHaveLength(4);
    });

    it('should include correct example calculations', () => {
      const info = getPricingInfo();

      // First example: 1 MB for 1 hour
      expect(info.examples[0].size).toBe('1 MB');
      expect(info.examples[0].duration).toBe('1 hour');
      expect(info.examples[0].price).toBe('$0.010000 USDC');
    });
  });
});
