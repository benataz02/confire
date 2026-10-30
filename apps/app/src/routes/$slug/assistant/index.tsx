import { createFileRoute } from "@tanstack/react-router";
import { AssistantPage } from "../../../assistant/AssistantPage.tsx";

// AI configuration: a new chat, which moves to its own address (`/assistant/$id`) once it has one.
export const Route = createFileRoute("/$slug/assistant/")({ component: () => <AssistantPage threadId={null} /> });
