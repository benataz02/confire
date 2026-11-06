import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { MasterdataEditor } from "../../../components/masterdata/MasterdataEditor.tsx";

export const Route = createFileRoute("/$slug/masterdata/new")({ head: () => title(t("NAV_MASTERDATA")), component: () => <MasterdataEditor /> });
