/**
 * CID Normalization
 *
 * Converts any valid CID input (CIDv0, CIDv1, various multibase encodings) to a
 * single canonical form: CIDv1 encoded in base32 ("bafy..."/"bafk..."). Used by
 * both the blocklist writer (admin API) and the gateway lookup path so that
 * differently-encoded references to the same content are blocked consistently.
 *
 * `multiformats/cid` is ESM-only, so we load it lazily via dynamic import.
 * Kept in its own module (no `pg` import) so tests can exercise it without
 * pulling in the Postgres driver.
 */

let _CID = null;

async function normalizeCid(cid) {
  if (!_CID) {
    const mod = await import('multiformats/cid');
    _CID = mod.CID;
  }
  return _CID.parse(String(cid).trim()).toV1().toString();
}

module.exports = { normalizeCid };
