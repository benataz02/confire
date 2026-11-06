import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { useQuery } from "@tanstack/react-query";
import { BusyIndicator, FlexBox, MessageStrip } from "@ui5/webcomponents-react";
import { AssistantPage } from "../../../assistant/AssistantPage.tsx";
import { refusalText } from "../../../assistant/ChatView.tsx";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";

// A saved report (reports spec §6.2): the AI page on the report's chat, opened to be read.
export const Route = createFileRoute("/$slug/reports/$id")({
  // As configs/$id: the page's own query, warmed for the title.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(orpc.reports.get.queryOptions({ input: { id: params.id } })).catch(() => undefined),
  head: ({ loaderData }) => title(loaderData?.title, t("ASSISTANT_PAGE_TITLE")),
  component: Report,
});

function Report() {
  const { id } = Route.useParams();
  const i18n = useI18n();
  const report = useQuery(orpc.reports.get.queryOptions({ input: { id } }));
  if (report.error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, report.error)}</MessageStrip>;
  if (!report.data) return <FlexBox fitContainer justifyContent="Center" alignItems="Center"><BusyIndicator active /></FlexBox>;
  return <AssistantPage key={id} threadId={report.data.threadId} reportId={id} />;
}
