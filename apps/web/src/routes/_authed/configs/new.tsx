import { createFileRoute } from "@tanstack/react-router";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

export const Route = createFileRoute("/_authed/configs/new")({ component: () => <ConfigProcessPage new /> });
