/** CIDv0 (Qm…) and CIDv1 (baf…) — the only shapes this service ever mints. */
export const CID_PATTERN =
  /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{40,90})$/;

export function isValidCid(value: unknown): value is string {
  return typeof value === 'string' && CID_PATTERN.test(value);
}
