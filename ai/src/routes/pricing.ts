/**
 * Pricing Routes
 *
 * GET /api/v1/pricing — public, no auth. Returns the current generation
 * costs so the FxFiles client can display the live price next to the
 * tracking toggle (and update reactively when the user flips it).
 *
 * Returning both values in one response lets the client switch
 * instantly without a second round-trip when the toggle changes.
 */

import { Hono } from 'hono';
import { config } from '../config/index.js';

export const pricingRoutes = new Hono();

pricingRoutes.get('/pricing', (c) => {
  return c.json({
    generationCostFula: config.generationCostFula,
    generationCostFulaWithTracking: config.generationCostFulaWithTracking,
    // Social post price; null when the feature is disabled (no Gemini key)
    // so the client can hide the button instead of offering a 503.
    socialPostPriceFula: config.geminiApiKey ? config.socialPostPriceFula : null,
    // Capability probe for "Recreate" — whether this deployment can EDIT
    // an existing site rather than design a new one. The client must know
    // BEFORE it submits: the generate request schema is non-strict, so an
    // older server drops `base_cid` without complaint and would charge
    // for a surprise redesign. An older server also omits this field, and
    // absent correctly reads as unsupported.
    supportsRevision: true,
  });
});

export default pricingRoutes;
