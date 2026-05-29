import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`,
  });

  console.log('--- Referral Cycle Cleanup Script ---');

  const client = await pool.connect();
  try {
    // 1. Detect cycles
    console.log('Detecting cycles...');
    const detectCyclesQuery = `
      WITH RECURSIVE referral_chain AS (
        SELECT referrer_id, referred_id, referred_at, ARRAY[referred_id] as path, FALSE as is_cycle
        FROM referrals
        UNION ALL
        SELECT r.referrer_id, r.referred_id, r.referred_at, rc.path || r.referred_id, r.referred_id = ANY(rc.path)
        FROM referrals r
        JOIN referral_chain rc ON r.referrer_id = rc.referred_id
        WHERE NOT rc.is_cycle
      )
      SELECT DISTINCT ON (referred_id) referred_id, referrer_id, referred_at
      FROM referral_chain
      WHERE is_cycle = TRUE
    `;

    const cycles = await client.query(detectCyclesQuery);
    console.log(`Found ${cycles.rowCount} cycles.`);

    if (cycles.rowCount && cycles.rowCount > 0) {
      console.log('Breaking cycles by removing the most recent edge in each loop...');
      for (const row of cycles.rows) {
        // In a cycle A -> B -> A, we might find both edges. 
        // We delete the one that was created later.
        console.log(`Deleting edge: ${row.referrer_id} -> ${row.referred_id} (created at ${row.referred_at})`);
        await client.query('DELETE FROM referrals WHERE referrer_id = $1 AND referred_id = $2', [row.referrer_id, row.referred_id]);
      }
      console.log('Cycles broken.');
    }

    // 2. Ensure referred_id uniqueness (Single-parent invariant)
    console.log('Checking for duplicate referred_ids (multiple parents)...');
    const detectDupesQuery = `
      SELECT referred_id, COUNT(*) 
      FROM referrals 
      GROUP BY referred_id 
      HAVING COUNT(*) > 1
    `;
    const dupes = await client.query(detectDupesQuery);
    console.log(`Found ${dupes.rowCount} users with multiple referrers.`);

    if (dupes.rowCount && dupes.rowCount > 0) {
      for (const row of dupes.rows) {
        console.log(`Cleaning up user ${row.referred_id}: keeping only the oldest referral edge.`);
        await client.query(`
          DELETE FROM referrals 
          WHERE referred_id = $1 
          AND id NOT IN (
            SELECT id FROM referrals 
            WHERE referred_id = $1 
            ORDER BY referred_at ASC 
            LIMIT 1
          )
        `, [row.referred_id]);
      }
      console.log('Duplicates resolved.');
    }

    // 3. Re-create the unique index properly
    console.log('Re-creating unique index idx_referrals_referred_id_unique...');
    await client.query('DROP INDEX IF EXISTS idx_referrals_referred_id_unique');
    await client.query('CREATE UNIQUE INDEX idx_referrals_referred_id_unique ON referrals(referred_id)');
    
    // Also update the app's internal index name if it was different
    await client.query('DROP INDEX IF EXISTS idx_referrals_referred_id');
    await client.query('CREATE UNIQUE INDEX idx_referrals_referred_id ON referrals(referred_id)');

    console.log('Unique index enforced successfully.');
    console.log('--- Cleanup Complete ---');

  } catch (err) {
    console.error('Cleanup failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
