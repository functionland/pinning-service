/**
 * Credit Service
 *
 * Deducts/refunds FULA credits via the pinning-webui admin API.
 * Uses a single adjustCredits() helper with fetch timeouts.
 */

import { config } from '../config/index.js';

export interface CreditOperationResult {
  success: boolean;
  newBalance?: number;
  insufficientBalance?: boolean;
  error?: string;
}

/** Truncate email for safe logging: "foo***" */
function safeEmail(email: string): string {
  return email.length > 3 ? `${email.slice(0, 3)}***` : '***';
}

/**
 * Core credit adjustment via pinning-webui /api/admin/adjust.
 *
 * @param userEmail - User email
 * @param jobId    - Job ID for logging/reference
 * @param amount   - Positive = add credits, negative = deduct credits
 * @param reason   - Reason string stored in credit history
 */
async function adjustCredits(
  userEmail: string,
  jobId: string,
  amount: number,
  reason: string,
): Promise<CreditOperationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${config.pinningWebuiUrl}/api/admin/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-System-Key': config.pinningSystemKey,
      },
      body: JSON.stringify({ email: userEmail, amount, reason }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[credits] Adjust failed for job ${jobId}: ${response.status} ${errorText}`);
      return { success: false, error: `Credit adjustment failed: ${response.status}` };
    }

    const result = (await response.json()) as {
      success: boolean;
      newBalance: number;
      isSuspended: boolean;
    };

    // For deductions (negative amount): check if balance went negative
    if (amount < 0 && result.newBalance < 0) {
      // Balance went negative — reverse the deduction immediately
      console.warn(
        `[credits] Insufficient balance for ${safeEmail(userEmail)} job ${jobId}, reversing deduction`,
      );
      const reverseController = new AbortController();
      const reverseTimeout = setTimeout(() => reverseController.abort(), 10_000);
      try {
        await fetch(`${config.pinningWebuiUrl}/api/admin/adjust`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-System-Key': config.pinningSystemKey,
          },
          body: JSON.stringify({
            email: userEmail,
            amount: -amount,
            reason: `ai:reverse:${jobId}`,
          }),
          signal: reverseController.signal,
        });
      } catch (reverseErr) {
        console.error(
          `[credits] CRITICAL: Failed to reverse deduction for job ${jobId}, ${safeEmail(userEmail)}, amount ${amount}:`,
          reverseErr,
        );
      } finally {
        clearTimeout(reverseTimeout);
      }
      return { success: false, insufficientBalance: true, newBalance: result.newBalance - amount };
    }

    const action = amount < 0 ? 'Deducted' : 'Refunded';
    console.log(
      `[credits] ${action} ${Math.abs(amount)} FULA for ${safeEmail(userEmail)} job ${jobId}, new balance: ${result.newBalance}`,
    );

    return { success: true, newBalance: result.newBalance };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error(`[credits] Timeout adjusting credits for job ${jobId}`);
      return { success: false, error: 'Credit service timeout' };
    }
    console.error(`[credits] Error adjusting credits for job ${jobId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Deduct credits from user account.
 * Returns insufficientBalance: true if the user doesn't have enough.
 */
export async function deductCredits(
  userEmail: string,
  jobId: string,
  amount: number,
): Promise<CreditOperationResult> {
  return adjustCredits(userEmail, jobId, -amount, `ai:generation:${jobId}`);
}

/**
 * Refund credits to user account (on generation failure).
 */
export async function refundCredits(
  userEmail: string,
  jobId: string,
  amount: number,
): Promise<CreditOperationResult> {
  return adjustCredits(userEmail, jobId, amount, `ai:refund:${jobId}`);
}
