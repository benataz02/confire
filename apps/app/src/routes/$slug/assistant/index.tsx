import { createFileRoute } from "@tanstack/react-router";
import { AssistantDock } from "../../../assistant/AssistantProvider.tsx";

// AI configuration: the chat alone, until it has started a configuration (then `/assistant/$id`).
export const Route = createFileRoute("/$slug/assistant/")({ component: AssistantDock });
