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
  });
});

export default pricingRoutes;
