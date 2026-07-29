/**
 * Legacy-client prompt compatibility.
 *
 * Older FxFiles builds prepend a client-side "=== SYSTEM CONSTRAINTS ==="
 * block to every generation prompt. Its 40KB / 1-3-files / "concise code"
 * output budget directly contradicts the rich output this service now asks
 * for (and every rule it asserts is re-asserted server-side), so the server
 * strips it from incoming prompts. Its presence also identifies a legacy
 * client (pre `pipeline_version`), which gets the faster single-pass
 * pipeline to stay inside the old 5-minute client poll deadline.
 */

export const LEGACY_CONSTRAINTS_START =
  '=== SYSTEM CONSTRAINTS (auto-added, do not repeat) ===';
export const LEGACY_CONSTRAINTS_END = '=== END SYSTEM CONSTRAINTS ===';

/** True when the prompt carries the pre-multipass FxFiles client block. */
export function hasLegacyConstraintsBlock(prompt: string): boolean {
  return prompt.includes(LEGACY_CONSTRAINTS_START);
}

/**
 * Remove the embedded legacy budget/constraints block (start marker through
 * the first end marker, inclusive), preserving everything around it.
 * Idempotent; a prompt without the block is returned unchanged. A start
 * marker without an end marker is left alone rather than risking eating
 * user content.
 */
export function stripLegacyConstraintsBlock(prompt: string): string {
  const start = prompt.indexOf(LEGACY_CONSTRAINTS_START);
  if (start === -1) {
    return prompt;
  }
  const endMarker = prompt.indexOf(LEGACY_CONSTRAINTS_END, start);
  if (endMarker === -1) {
    return prompt;
  }
  let end = endMarker + LEGACY_CONSTRAINTS_END.length;
  // Swallow the trailing newline(s) the client emits after the block.
  while (prompt[end] === '\n' || prompt[end] === '\r') {
    end++;
  }
  return (prompt.slice(0, start) + prompt.slice(end)).trimStart();
}
