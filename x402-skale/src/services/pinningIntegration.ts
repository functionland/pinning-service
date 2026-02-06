/**
 * Pinning Service Credit Integration
 *
 * Adjusts credits in the pinning service after x402 payment settlement.
 * Uses the existing admin adjust endpoint.
 */

import { config } from '../config/index.js';
import { usdcToFula } from '../utils/pricing.js';
import type { CreditAdjustmentRequest, CreditAdjustmentResponse } from '../types/index.js';

/**
 * Adjust credits in the pinning service
 *
 * Converts USDC payment to FULA credits and adds to user's account.
 * Uses JWT email (real user identity) for credit assignment.
 *
 * @param userEmail - User's email from JWT sub claim (real identity)
 * @param wallet - Payer's wallet address (for logging only)
 * @param amountUsdc - Payment amount in USDC
 * @param paymentId - x402 payment ID for audit
 * @param sizeMb - Storage size in MB
 * @param ttlHours - TTL in hours
 */
export async function adjustPinningCredits(params: {
  userEmail: string;
  wallet: string;
  amountUsdc: number;
  paymentId: string;
  sizeMb: number;
  ttlHours: number;
}): Promise<CreditAdjustmentResponse> {
  const { userEmail, wallet, amountUsdc, paymentId, sizeMb, ttlHours } = params;

  // Convert USDC to FULA credits
  const fulaAmount = usdcToFula(amountUsdc);

  // Use JWT email directly (real user identity, not synthetic wallet email)
  const email = userEmail;

  // Build reason string for audit
  const reason = sizeMb === 0 && ttlHours === 0
    ? `x402:${paymentId}:credit-topup`
    : `x402:${paymentId}:${sizeMb.toFixed(2)}MB×${ttlHours}h`;

  const request: CreditAdjustmentRequest = {
    email,
    amount: fulaAmount,
    reason,
  };

  try {
    console.log(`[pinning] Adjusting credits: ${email} +${fulaAmount} FULA (paid by ${wallet}) (${reason})`);

    const response = await fetch(`${config.pinningWebuiUrl}/api/admin/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-System-Key': config.pinningSystemKey,
      },
      body: JSON.stringify(request),
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

    console.log(`[pinning] Credits adjusted: ${email} new balance ${result.newBalance} FULA`);

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
  const email = `${wallet.toLowerCase()}@x402.gateway`;

  try {
    // This would need an endpoint in the pinning service
    // For now, we assume x402 payments always provide sufficient credits
    console.log(`[pinning] Credit check for ${email} (skipped - x402 handles payment)`);

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
  const email = `${wallet.toLowerCase()}@x402.gateway`;

  try {
    // Try to adjust by 0 to ensure user exists
    await fetch(`${config.pinningWebuiUrl}/api/admin/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-System-Key': config.pinningSystemKey,
      },
      body: JSON.stringify({
        email,
        amount: 0,
        reason: 'x402:user-init',
      }),
    });

    return true;

  } catch {
    return false;
  }
}

export default adjustPinningCredits;
