/**
 * Pinning Service Credit Integration
 *
 * Adjusts credits in the pinning service after x402 payment settlement.
 * Uses the existing admin adjust endpoint. Identifies users by userId hash only.
 */

import { config } from '../config/index.js';
import { usdcToFula } from '../utils/pricing.js';
import { walletToUserId } from './walletUser.js';
import type { CreditAdjustmentRequest, CreditAdjustmentResponse } from '../types/index.js';

/**
 * Adjust credits in the pinning service
 *
 * Converts USDC payment to FULA credits and adds to user's account.
 * Uses userId hash (from JWT sub claim) for credit assignment.
 */
export async function adjustPinningCredits(params: {
  userId: string;
  wallet: string;
  amountUsdc: number;
  paymentId: string;
  sizeMb: number;
  ttlHours: number;
}): Promise<CreditAdjustmentResponse> {
  const { userId, wallet, amountUsdc, paymentId, sizeMb, ttlHours } = params;

  // Convert USDC to FULA credits
  const fulaAmount = usdcToFula(amountUsdc);

  // Build reason string for audit
  const reason = sizeMb === 0 && ttlHours === 0
    ? `x402:${paymentId}:credit-topup`
    : `x402:${paymentId}:${sizeMb.toFixed(2)}MB×${ttlHours}h`;

  const request: CreditAdjustmentRequest = {
    userId,
    amount: fulaAmount,
    reason,
  };

  try {
    console.log(`[pinning] Adjusting credits: ${userId.slice(0, 8)}... +${fulaAmount} FULA (wallet ${wallet.slice(0, 6)}...) (${reason})`);

    const response = await fetch(`${config.pinningWebuiUrl}/api/admin/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-System-Key': config.pinningSystemKey,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[pinning] Credit adjustment failed: ${response.status} ${errorText}`);

      return {
        success: false,
        error: `Credit adjustment failed: ${response.status} ${errorText}`,
      };
    }

    const result = await response.json() as { newBalance: number; isSuspended?: boolean };

    console.log(`[pinning] Credits adjusted: ${userId.slice(0, 8)}... new balance ${result.newBalance} FULA`);

    return {
      success: true,
      newBalance: result.newBalance,
      isSuspended: result.isSuspended,
    };

  } catch (error) {
    console.error('[pinning] Credit adjustment error:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if a user has sufficient credits in the pinning service
 */
export async function checkPinningCredits(wallet: string): Promise<{
  canUpload: boolean;
  balanceFula: number;
  message: string;
}> {
  const userId = walletToUserId(wallet);

  try {
    // For now, we assume x402 payments always provide sufficient credits
    console.log(`[pinning] Credit check for ${userId.slice(0, 8)}... (skipped - x402 handles payment)`);

    return {
      canUpload: true,
      balanceFula: 0,
      message: 'x402 payment covers storage',
    };

  } catch (error) {
    console.error('[pinning] Credit check error:', error);

    return {
      canUpload: true, // Fail open for x402 payments
      balanceFula: 0,
      message: 'Credit check unavailable',
    };
  }
}

/**
 * Ensure user exists in pinning service
 * (Creates if not exists via the adjust endpoint with 0 amount)
 */
export async function ensurePinningUser(wallet: string): Promise<boolean> {
  const userId = walletToUserId(wallet);

  try {
    await fetch(`${config.pinningWebuiUrl}/api/admin/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-System-Key': config.pinningSystemKey,
      },
      body: JSON.stringify({
        userId,
        amount: 0,
        reason: 'x402:user-init',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    return true;

  } catch {
    return false;
  }
}

export default adjustPinningCredits;
