import { createFileRoute } from "@tanstack/react-router";
import { AssistantPage } from "../../../assistant/AssistantPage.tsx";

// One of the user's chats, beside the list of the others.
export const Route = createFileRoute("/$slug/assistant/$id")({ component: Chat });

function Chat() {
  const { id } = Route.useParams();
  return <AssistantPage threadId={id} />;
}
