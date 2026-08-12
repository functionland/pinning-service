/**
 * FM-2 (federated masters) unit tests — DB-free surface.
 *
 * The multi-master behaviors (ON CONFLICT dedup, atomic deposit credit,
 * advisory-lock lease arbitration) are exercised end-to-end against a real
 * Postgres in the Phase 1.5 e2e suite; these tests pin down the pure logic
 * and the flag-off defaults that keep single-master behavior byte-identical.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { currentHourBucket, calculateHourlyDeduction, FREE_TIER_BYTES } from '../server/services/deductionJob';
import { isLeaseEnabled, leaseGate, leaseHeldSince } from '../server/services/leaderLease';

const GB = 1024 * 1024 * 1024;

describe('currentHourBucket (deduction idempotency key)', () => {
  it('formats as hour:YYYY-MM-DDTHH in UTC', () => {
    expect(currentHourBucket(new Date('2026-06-12T14:59:59.999Z'))).toBe('hour:2026-06-12T14');
  });

  it('is stable for any instant within the same UTC hour', () => {
    const a = currentHourBucket(new Date('2026-06-12T14:00:00.000Z'));
    const b = currentHourBucket(new Date('2026-06-12T14:59:59.999Z'));
    expect(a).toBe(b);
  });

  it('differs across hour boundaries (no cross-hour dedup)', () => {
    const a = currentHourBucket(new Date('2026-06-12T14:59:59.999Z'));
    const b = currentHourBucket(new Date('2026-06-12T15:00:00.000Z'));
    expect(a).not.toBe(b);
  });

  it('is UTC-based regardless of local timezone offsets in input', () => {
    // Same instant expressed with an offset must yield the same bucket.
    const utc = currentHourBucket(new Date('2026-06-12T23:30:00.000Z'));
    const offset = currentHourBucket(new Date('2026-06-13T01:30:00.000+02:00'));
    expect(offset).toBe(utc);
  });

  it('two masters computing the key in the same hour collide (the point)', () => {
    const masterA = currentHourBucket(new Date('2026-06-12T14:03:21.111Z'));
    const masterB = currentHourBucket(new Date('2026-06-12T14:47:09.420Z'));
    expect(masterA).toBe(masterB);
  });
});

describe('calculateHourlyDeduction (unchanged by FM-2)', () => {
  it('charges 0 at or under the free tier', () => {
    expect(calculateHourlyDeduction(FREE_TIER_BYTES)).toBe(0);
    expect(calculateHourlyDeduction(0)).toBe(0);
  });

  it('charges (GB - free) * 3 / 720 per hour over the tier', () => {
    const bytes = FREE_TIER_BYTES + 10 * GB;
    expect(calculateHourlyDeduction(bytes)).toBeCloseTo((10 * 3) / 720, 10);
  });
});

describe('leaderLease flag-off defaults (legacy single-master)', () => {
  const saved = process.env.CRON_LEADER_LEASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_LEADER_LEASE;
    else process.env.CRON_LEADER_LEASE = saved;
  });

  it('lease is disabled unless CRON_LEADER_LEASE=true', () => {
    delete process.env.CRON_LEADER_LEASE;
    expect(isLeaseEnabled()).toBe(false);
    process.env.CRON_LEADER_LEASE = 'false';
    expect(isLeaseEnabled()).toBe(false);
    process.env.CRON_LEADER_LEASE = 'true';
    expect(isLeaseEnabled()).toBe(true);
  });

  it('leaseGate is a constant-true no-op when disabled (no DB touched)', async () => {
    delete process.env.CRON_LEADER_LEASE;
    // No Postgres is reachable in unit tests — this would throw/hang if the
    // gate touched the pool. It must short-circuit to true.
    await expect(leaseGate('unit-test')).resolves.toBe(true);
    expect(leaseHeldSince()).toBeNull();
  });
});
