import { createFileRoute } from "@tanstack/react-router";
import { MasterdataEditor } from "../../../components/masterdata/MasterdataEditor.tsx";

export const Route = createFileRoute("/$slug/masterdata/new")({ component: () => <MasterdataEditor /> });
