/** 32 random bytes, base64url — the value both sides share: `secret` in the agent's agent.json. */
export function generateAgentSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Copy a visible input's value, selected so the user sees what went. Dev's `localhost` is a secure
 *  context like https, so the Clipboard API is always there. */
export function copyInput(input: HTMLInputElement | null | undefined): boolean {
  if (!input) return false;
  input.select();
  void navigator.clipboard.writeText(input.value);
  return true;
}
