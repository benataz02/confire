import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Button, Card, CardHeader, FileUploader, FlexBox, Form, FormItem, Input, Label, MessageStrip, Text,
} from "@ui5/webcomponents-react";
import { sameState } from "@confire/ui/views.ts";
import { toast } from "@confire/ui/toast.ts";
import { logoUrl, uploadLogo } from "@confire/ui/files.ts";
import { client, orpc } from "../../orpc.ts";

// Settings → Portal → Branding (spec D20): the name, accent colour and logo the portal and its client
// mail wear, each falling back to the workspace's own. Postgres only (portalSettings.general), so
// SAP being down never costs this card.

export type General = Awaited<ReturnType<typeof client.portalSettings.general>>;

/** One query for the tab's P7 cards; each renders its own loading and error. */
export function useGeneral() {
  return useQuery(orpc.portalSettings.general.queryOptions());
}

export function GeneralCard({ title, subtitle, children }: {
  title: string; subtitle: string; children: (current: General) => ReactNode;
}) {
  const q = useGeneral();
  return (
    <Card header={<CardHeader titleText={title} subtitleText={subtitle} />}>
      {q.data ? children(q.data)
        : q.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>
        : <BusyIndicator active style={{ margin: "1rem" }} />}
    </Card>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const HORIZON_BLUE = "#0a6ed1";

export function PortalBranding() {
  return (
    <GeneralCard title="Branding" subtitle="How your customer portal and your client mail look">
      {(current) => <BrandingForm current={current} />}
    </GeneralCard>
  );
}

function BrandingForm({ current }: { current: General }) {
  const qc = useQueryClient();
  const stored = {
    displayName: current.branding.displayName ?? "", accent: current.branding.accent ?? "",
    logoFileId: current.branding.logoFileId ?? null,
  };
  const [draft, setDraft] = useState(stored);
  // A refetch after save re-seeds the draft from what the server now holds.
  useEffect(() => setDraft(stored), [current.branding]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [picks, setPicks] = useState(0);
  const save = useMutation(orpc.portalSettings.save.mutationOptions({
    onSuccess: () => {
      toast("Branding saved");
      void qc.invalidateQueries({ queryKey: orpc.portalSettings.general.key() });
    },
  }));

  const accentBad = draft.accent !== "" && !HEX.test(draft.accent);
  const logo = draft.logoFileId ? logoUrl(draft.logoFileId) : current.organization.logo;
  const pickLogo = async (file: File | undefined) => {
    setPicks((n) => n + 1);
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { id } = await uploadLogo(file);
      setDraft((d) => ({ ...d, logoFileId: id }));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
      <Form accessibleMode="Edit" labelSpan="S12 M4 L4 XL4" layout="S1 M1 L1 XL1">
        <FormItem labelContent={<Label for="brand-name">Display name</Label>}>
          <Input id="brand-name" value={draft.displayName} placeholder={current.organization.name} maxlength={100}
            onInput={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))} />
        </FormItem>
        <FormItem labelContent={<Label for="brand-accent">Accent colour</Label>}>
          <FlexBox style={{ gap: "0.5rem", alignItems: "center", width: "100%" }}>
            {/* The platform's own picker; the text field takes a pasted hex code. */}
            <input type="color" aria-label="Pick the accent colour" value={HEX.test(draft.accent) ? draft.accent : HORIZON_BLUE}
              style={{ inlineSize: "2.25rem", blockSize: "2.25rem", padding: 0, border: "none", background: "none", cursor: "pointer" }}
              onChange={(e) => setDraft((d) => ({ ...d, accent: e.target.value }))} />
            <Input id="brand-accent" value={draft.accent} placeholder={`${HORIZON_BLUE} (SAP blue)`} style={{ flex: 1 }}
              valueState={accentBad ? "Negative" : "None"} valueStateMessage={<div>A colour such as #0a6ed1</div>}
              onInput={(e) => setDraft((d) => ({ ...d, accent: e.target.value.trim() }))} />
            <Button design="Transparent" disabled={!draft.accent} onClick={() => setDraft((d) => ({ ...d, accent: "" }))}>Default</Button>
          </FlexBox>
        </FormItem>
        <FormItem labelContent={<Label>Logo</Label>}>
          <FlexBox style={{ gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            {logo ? <img src={logo} alt="Logo" style={{ blockSize: "2.5rem", maxInlineSize: "10rem", objectFit: "contain" }} />
              : <Text style={{ color: "var(--sapContent_LabelColor)" }}>None</Text>}
            <FileUploader key={picks} hideInput accept=".png,.jpg,.jpeg" maxFileSize={1} disabled={uploading}
              accessibleName="Upload a logo"
              onFileSizeExceed={() => { setPicks((n) => n + 1); setUploadError("A logo can be up to 1 MB"); }}
              onChange={(e) => void pickLogo(e.detail.files?.[0])}>
              <Button icon="upload" disabled={uploading}>{uploading ? "Uploading…" : "Upload"}</Button>
            </FileUploader>
            {draft.logoFileId ? (
              <Button design="Transparent" onClick={() => setDraft((d) => ({ ...d, logoFileId: null }))}>Remove</Button>
            ) : null}
          </FlexBox>
        </FormItem>
      </Form>
      {uploadError ? <MessageStrip design="Negative" hideCloseButton>{uploadError}</MessageStrip> : null}
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>
        The accent colours the portal's shell bar and main buttons, and the button in your client mail. White text has to
        stay readable on it, so very light colours are refused. The logo is a PNG or JPEG of up to 1 MB, shown at 32 px.
      </Text>
      <Button design="Emphasized" style={{ alignSelf: "start" }}
        disabled={sameState(draft, stored) || accentBad || uploading || save.isPending}
        onClick={() => save.mutate({
          branding: {
            ...(draft.displayName.trim() ? { displayName: draft.displayName.trim() } : {}),
            ...(draft.accent ? { accent: draft.accent } : {}),
            ...(draft.logoFileId ? { logoFileId: draft.logoFileId } : {}),
          },
        })}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </FlexBox>
  );
}
