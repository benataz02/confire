import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IllustratedMessage, List, ListItemStandard, Text, Title } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { authClient } from "../../auth-client.ts";
import { lobbyQuery, meQuery } from "../../orpc.ts";
import { PortalAuthLayout } from "../../components/AuthChrome.tsx";
import { hardRedirect, isApex, tenantUrl } from "../../lib/host.ts";
import { roleLabel } from "../../components/PortalShell.tsx";

// `/` is two pages: on the apex, the supplier lobby (spec §9) — every supplier this user has a seat
// at; on a supplier's host, the portal home inside the shell.
export const Route = createFileRoute("/_authed/")({
  beforeLoad: async ({ context }) => {
    if (!isApex()) return;
    // Exactly one supplier: nothing to choose, go there.
    const lobby = await context.queryClient.fetchQuery(lobbyQuery);
    if (lobby.length === 1) return hardRedirect(tenantUrl(lobby[0]!.slug));
  },
  component: () => (isApex() ? <Lobby /> : <Home />),
});

function Lobby() {
  const lobby = useQuery(lobbyQuery);
  const queryClient = useQueryClient();
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/login");
  };
  const rows = lobby.data ?? [];

  return (
    <PortalAuthLayout>
      <h2 className="auth-h1">{rows.length ? "Choose a supplier" : "No supplier portal yet"}</h2>
      {rows.length ? (
        <List
          onItemClick={(e) => {
            const slug = (e.detail.item as HTMLElement).dataset.slug;
            if (slug) void hardRedirect(tenantUrl(slug));
          }}
        >
          {rows.map((r) => (
            <ListItemStandard key={r.slug} data-slug={r.slug} icon="supplier" description={r.cardName} additionalText={roleLabel(r.role)}>
              {r.tenantName}
            </ListItemStandard>
          ))}
        </List>
      ) : (
        <p className="auth-sub">
          {lobby.isPending
            ? "Loading…"
            : "Your account isn't linked to a supplier's portal yet. Open the invitation link from your supplier's email to get started."}
        </p>
      )}
      <p className="auth-alt">
        <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a>
      </p>
    </PortalAuthLayout>
  );
}

function Home() {
  // Primed by _authed's beforeLoad, which only lets a user with a seat through.
  const me = useQuery(meQuery).data!;
  return (
    <div style={{ padding: "2rem" }}>
      <Title level="H2">Welcome, {me.user.name}</Title>
      <Text style={{ color: "var(--sapContent_LabelColor)", marginTop: "0.5rem" }}>
        {me.company!.cardName} · {me.tenant.name}'s customer portal
      </Text>
      {/* ponytail: the P7 home overview (open requests, quotes awaiting you, recent documents) replaces this. */}
      <IllustratedMessage
        name="NoEntries"
        titleText="Nothing here yet"
        subtitleText={`Your requests, quotes and documents with ${me.tenant.name} will appear here.`}
      />
    </div>
  );
}
