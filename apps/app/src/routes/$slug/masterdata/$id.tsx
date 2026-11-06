import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { MasterdataEditor } from "../../../components/masterdata/MasterdataEditor.tsx";

export const Route = createFileRoute("/$slug/masterdata/$id")({ head: () => title(t("NAV_MASTERDATA")), component: Editor });

function Editor() {
  const { id } = Route.useParams();
  return <MasterdataEditor key={id} id={id} />;
}
