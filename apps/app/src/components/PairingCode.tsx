import { useEffect, useState } from "react";
import { Button, FlexBox, Link, Text } from "@ui5/webcomponents-react";
import { authUrl } from "@confire/ui/host.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { useI18n } from "../i18n.ts";

// Install day in Confire (spec 2026-10-21 §3): the download — a plain link, short enough to type on
// the SAP server — and the one-time code its wizard asks for last. Onboarding and Settings → SAP
// agent both show it; each issues the code through its own procedure.

const DOWNLOAD = authUrl("/download/confire-agent.exe");

export function PairingCode({ code, onNewCode, busy }: {
  code: { code: string; expiresAt: Date } | null;
  onNewCode: () => void;
  busy: boolean;
}) {
  const i18n = useI18n();
  // Re-render now and then, so an expired code says so without a reload.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const expired = !!code && code.expiresAt.getTime() <= now;

  return (
    <FlexBox direction="Column" style={{ gap: "0.75rem" }}>
      <Text>{i18n.getText("ADMIN_PAIR_DOWNLOAD")}</Text>
      <Link href={DOWNLOAD} wrappingType="Normal">{DOWNLOAD}</Link>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>{i18n.getText("ADMIN_PAIR_SMARTSCREEN")}</Text>
      <Text>{i18n.getText("ADMIN_PAIR_CODE")}</Text>
      <FlexBox alignItems="Center" style={{ gap: "1rem", flexWrap: "wrap" }}>
        <code aria-live="polite" style={{
          fontSize: "1.75rem", letterSpacing: "0.15em", fontWeight: 600,
          textDecoration: expired ? "line-through" : undefined, opacity: code ? 1 : 0.4,
        }}>
          {code?.code ?? "····-····"}
        </code>
        <Button icon="refresh" disabled={busy} onClick={onNewCode}>{i18n.getText("ADMIN_PAIR_NEW_CODE")}</Button>
      </FlexBox>
      {code ? (
        <Text>{expired ? i18n.getText("ADMIN_PAIR_EXPIRED")
          : i18n.getText("ADMIN_PAIR_VALID", code.expiresAt.toLocaleTimeString(formatLocale(), { hour: "2-digit", minute: "2-digit" }))}</Text>
      ) : null}
    </FlexBox>
  );
}
