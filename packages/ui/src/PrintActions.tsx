import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bar, Button, Dialog, Modals, Text } from "@ui5/webcomponents-react";
import { useUiI18n } from "./i18n.ts";
import { useUiSource } from "./source.tsx";

// The one place printing exists in the UI, for both apps. Everything that can print a SAP document
// — an object page, a list report's count bar, a timeline row — renders this and nothing else, so
// there is exactly one blob-URL lifecycle to get right. Preview only: the browser's PDF viewer has
// its own save and print. It prints through the app's source (`entities.print` internally,
// `docs.print` on the portal), so the server's rule is the one that applies.
//
// The apps do not depend on @confire/server at runtime (only `import type` for the routers), so the
// PRINTABLE list is restated here rather than imported. The server's PRINTABLE is the real
// boundary; this only decides whether to draw a button.
export const PRINTABLE_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

/** An oRPC error code (b1.ts toOrpcError) -> the sentence a user reads. BAD_REQUEST is SAP refusing
 *  the export (no print layout for the document type, the API Gateway's own 400), like BAD_GATEWAY. */
const ERROR_TEXT: Record<string, string> = {
  SERVICE_UNAVAILABLE: "UI_PREVIEW_ERR_UNAVAILABLE",
  BAD_GATEWAY: "UI_PREVIEW_ERR_SAP",
  BAD_REQUEST: "UI_PREVIEW_ERR_SAP",
  NOT_FOUND: "UI_PREVIEW_ERR_NOT_FOUND",
  CONFLICT: "UI_PREVIEW_ERR_CONFLICT",
  FORBIDDEN: "UI_PREVIEW_ERR_FORBIDDEN",
};

/** base64 -> a blob URL the browser's own PDF viewer can open.
 *  // ponytail: iframe + the browser's viewer; a real viewer only if someone needs annotations. */
const toBlobUrl = (pdf: string) =>
  URL.createObjectURL(new Blob([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], { type: "application/pdf" }));

export function PrintActions({ entity, docEntry, disabled }: { entity: string; docEntry: number; disabled?: boolean }) {
  const { client } = useUiSource();
  const i18n = useUiI18n();
  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);
  // A failure is a MessageBox, not a strip: the button sits in a toolbar, where a strip pushes the
  // other actions into the overflow (and outlives the click that caused it). The sentence comes from
  // the error's code; the server's text (often the agent's or SAP's own) stays below as the details
  // an admin needs to fix it.
  const print = useMutation({
    mutationFn: (input: { entity: string; docEntry: number }) => client.entities.print(input),
    onError: (e) => {
      const code = String((e as { code?: unknown }).code ?? "");
      Modals.showMessageBox({
        type: "Error",
        titleText: i18n.getText("UI_PREVIEW_FAILED"),
        children: (
          <>
            <Text>{i18n.getText(ERROR_TEXT[code] ?? "UI_PREVIEW_ERR_OTHER")}</Text>
            {e.message ? (
              <Text style={{ display: "block", marginTop: "0.75rem", color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" }}>
                {i18n.getText("UI_ERROR_DETAILS", e.message)}
              </Text>
            ) : null}
          </>
        ),
      });
    },
  });

  // A blob URL is a document-lifetime allocation; release it when the dialog closes or we unmount.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  if (!PRINTABLE_ENTITIES.has(entity)) return null;
  // No document (a list with no single row selected) still draws the button, disabled.
  const none = !Number.isFinite(docEntry);

  const open = async () => {
    const res = await print.mutateAsync({ entity, docEntry }).catch(() => null);
    if (res) setPreview({ url: toBlobUrl(res.pdf), fileName: res.fileName });
  };

  const close = () => {
    setPreview((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
  };

  return (
    <>
      {/* `loading` also swallows clicks while the print runs (UI5's Button), so no double request. */}
      <Button icon="pdf-attachment" design="Transparent" disabled={disabled || none}
        loading={print.isPending} loadingDelay={0} onClick={() => void open()}>
        {i18n.getText("UI_PREVIEW")}
      </Button>
      <Dialog
        stretch
        open={!!preview}
        headerText={preview?.fileName ?? ""}
        onClose={close}
        footer={<Bar design="Footer" endContent={<Button onClick={close}>{i18n.getText("UI_CLOSE")}</Button>} />}
      >
        {preview ? (
          <iframe src={preview.url} title={preview.fileName}
            style={{ width: "100%", height: "100%", border: 0 }} />
        ) : null}
      </Dialog>
    </>
  );
}
