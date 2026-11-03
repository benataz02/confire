import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { client } from "../../../orpc.ts";
import { refusalText } from "../../../assistant/ChatView.tsx";
import { useI18n } from "../../../i18n.ts";

// New report: the user's blank report (`reports.create` reuses it), under its own address — as the
// AI page's New chat is the user's blank thread.
export const Route = createFileRoute("/$slug/reports/new")({ component: NewReport });

function NewReport() {
  const i18n = useI18n();
  const navigate = useNavigate({ from: "/$slug" });
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    client.reports.create().then(({ id }) => navigate({ to: "/$slug/reports/$id", params: { id }, replace: true }), setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return error
    ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, error)}</MessageStrip>
    : <BusyIndicator active style={{ margin: "auto" }} />;
}
