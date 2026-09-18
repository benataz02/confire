import { createFileRoute } from "@tanstack/react-router";
import { QuoteCreatePage } from "../../../components/configurator/QuoteCreatePage.tsx";

// Standalone, not nested under /configs/$id: the trailing `_` opts out, the same way
// b1/$entity_.$key does, so the quotation gets the whole page rather than a section of the
// configurator's ObjectPage.
export const Route = createFileRoute("/_authed/configs/$id_/quote")({
  component: () => {
    const { id } = Route.useParams();
    return <QuoteCreatePage key={id} projectId={id} />;
  },
});
