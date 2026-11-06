import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { AssistantPage } from "../../../assistant/AssistantPage.tsx";

// AI configuration: a new chat, which moves to its own address (`/assistant/$id`) once it has one.
export const Route = createFileRoute("/$slug/assistant/")({ head: () => title(t("ASSISTANT_PAGE_TITLE")), component: () => <AssistantPage threadId={null} /> });
