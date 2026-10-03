/** 32 random bytes, base64url — the value both sides share: `secret` in the agent's agent.json. */
export function generateAgentSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Select a visible input, then copy. The Clipboard API is gone on http://lvh.me (not a secure
 *  context), so execCommand on a selected input is the path that works in dev. */
export function copyInput(input: HTMLInputElement | null | undefined): boolean {
  if (!input) return false;
  input.focus();
  input.select();
  if (document.execCommand("copy")) return true;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(input.value);
    return true;
  }
  return false;
}
