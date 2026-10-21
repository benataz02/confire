import { createFileRoute } from "@tanstack/react-router";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

export const Route = createFileRoute("/$slug/configs/new")({ component: () => <ConfigProcessPage new /> });
