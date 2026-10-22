import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, Dialog, MessageStrip } from "@ui5/webcomponents-react";
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

/** base64 -> a blob URL the browser's own PDF viewer can open.
 *  // ponytail: iframe + the browser's viewer; a real viewer only if someone needs annotations. */
const toBlobUrl = (pdf: string) =>
  URL.createObjectURL(new Blob([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], { type: "application/pdf" }));

export function PrintActions({ entity, docEntry, disabled }: { entity: string; docEntry: number; disabled?: boolean }) {
  const { client } = useUiSource();
  const i18n = useUiI18n();
  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);
  const print = useMutation({ mutationFn: (input: { entity: string; docEntry: number }) => client.entities.print(input) });

  // A blob URL is a document-lifetime allocation; release it when the dialog closes or we unmount.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  if (!PRINTABLE_ENTITIES.has(entity) || !Number.isFinite(docEntry)) return null;

  const open = async () => {
    const res = await print.mutateAsync({ entity, docEntry });
    setPreview({ url: toBlobUrl(res.pdf), fileName: res.fileName });
  };

  const close = () => {
    setPreview((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
  };

  return (
    <>
      <Button icon="pdf-attachment" design="Transparent" disabled={disabled || print.isPending} onClick={() => void open()}>
        {i18n.getText("UI_PREVIEW")}
      </Button>
      {print.error ? <MessageStrip design="Negative" hideCloseButton>{print.error.message}</MessageStrip> : null}
      {print.isPending ? <BusyIndicator active delay={0} /> : null}
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
