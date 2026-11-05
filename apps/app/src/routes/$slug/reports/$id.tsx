import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BusyIndicator, FlexBox, MessageStrip } from "@ui5/webcomponents-react";
import { AssistantPage } from "../../../assistant/AssistantPage.tsx";
import { refusalText } from "../../../assistant/ChatView.tsx";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";

// A saved report (reports spec §6.2): the AI page on the report's chat, opened to be read.
export const Route = createFileRoute("/$slug/reports/$id")({ component: Report });

function Report() {
  const { id } = Route.useParams();
  const i18n = useI18n();
  const report = useQuery(orpc.reports.get.queryOptions({ input: { id } }));
  if (report.error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, report.error)}</MessageStrip>;
  if (!report.data) return <FlexBox fitContainer justifyContent="Center" alignItems="Center"><BusyIndicator active /></FlexBox>;
  return <AssistantPage key={id} threadId={report.data.threadId} reportId={id} />;
}
