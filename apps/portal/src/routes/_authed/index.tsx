import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { IllustratedMessage, Text, Title } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { meQuery } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/")({
  component: Home,
});

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
