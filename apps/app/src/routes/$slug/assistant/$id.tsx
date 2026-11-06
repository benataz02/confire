import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { AssistantPage } from "../../../assistant/AssistantPage.tsx";

// One of the user's chats, beside the list of the others.
export const Route = createFileRoute("/$slug/assistant/$id")({ head: () => title(t("ASSISTANT_PAGE_TITLE")), component: Chat });

function Chat() {
  const { id } = Route.useParams();
  return <AssistantPage threadId={id} />;
}
