import { createContext, useContext } from "react";
import type { RouterClient } from "@orpc/server";
import type { RouterUtils } from "@orpc/tanstack-query";
import type { AppRouter } from "@confire/server/router";

type Client = RouterClient<AppRouter>;
type Utils = RouterUtils<Client>;

/**
 * Everything the shells read and write, handed in by the app that renders them (portal spec §15
 * P1: the data-source seam). It is shaped as the internal router's own client and query utils on
 * purpose: the query keys stay the app's, so the app's own cache writes still land —
 * QuoteCreatePage seeds `entities.one`, the B1 list's refresh writes `entities.metadata`. Another
 * app plugs in by building an object of this shape over its own procedures.
 */
export type UiSource = {
  client: {
    entities: Pick<Client["entities"], "rows" | "neighbor" | "print">;
    /** The configurator's value help pages here. The portal plugs its own `projects.queryPage` in. */
    configs: Pick<Client["configs"], "queryPage">;
  };
  orpc: {
    entities: Pick<Utils["entities"], "metadata" | "one" | "create" | "update">;
    views: Pick<Utils["views"], "list" | "setActive" | "create" | "update" | "remove" | "getState" | "setState">;
  };
  /** This user's role on the tenant, undefined until known. A hook: called during render. */
  useRole: () => string | undefined;
  /** The tenant's B1 local currency for every money figure, undefined until SAP has said. A hook. */
  useCurrency: () => string | undefined;
};

const Ctx = createContext<UiSource | null>(null);

export const UiSourceProvider = Ctx.Provider;

export function useUiSource(): UiSource {
  const source = useContext(Ctx);
  if (!source) throw new Error("A @confire/ui component rendered outside <UiSourceProvider>");
  return source;
}
