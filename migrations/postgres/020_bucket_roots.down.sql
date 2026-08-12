-- Revert migration 020. Guarded: dropping the arbiter table while any master
-- still runs with FULA_BUCKET_ROOT_CAS=true would break its flushes — turn
-- the flag off on ALL masters first. The table holds only derived pointers
-- (the authoritative data lives in IPFS/the registry), so the drop loses no
-- user data.
DROP TABLE IF EXISTS bucket_roots;
