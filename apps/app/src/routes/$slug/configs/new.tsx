import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

export const Route = createFileRoute("/$slug/configs/new")({ head: () => title(t("NAV_CONFIGS")), component: () => <ConfigProcessPage new /> });
