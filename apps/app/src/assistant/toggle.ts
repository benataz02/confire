// The ShellBar's assistant toggle (assistant spec §4.2): while the assistant cannot run here it is
// disabled and its tooltip says why — the workspace's switch (an admin turns it on in Settings) or
// no API key on the server (whoever runs Confire sets it) — rather than opening a panel onto a "no".

type Status = { enabled: boolean; reason: "switch" | "no_key" | null } | undefined;

export function assistantToggle(s: Status, t: (key: string) => string): { disabled: boolean; tooltip: string } {
  if (!s) return { disabled: true, tooltip: t("ASSISTANT_TITLE") };
  if (s.enabled) return { disabled: false, tooltip: t("ASSISTANT_TITLE") };
  return s.reason === "no_key"
    ? { disabled: true, tooltip: `${t("ASSISTANT_NO_KEY")}. ${t("ASSISTANT_NO_KEY_SUB")}` }
    : { disabled: true, tooltip: `${t("ASSISTANT_OFF")}. ${t("ASSISTANT_OFF_SUB")}` };
}
