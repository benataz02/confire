import { createFileRoute } from "@tanstack/react-router";
import { AssistantDock } from "../../../assistant/AssistantProvider.tsx";

// One configuration, worked on in the chat alone. The panel reads the id off the route.
export const Route = createFileRoute("/$slug/assistant/$id")({ component: AssistantDock });
