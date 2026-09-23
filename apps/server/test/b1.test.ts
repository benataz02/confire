import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { agentTarget } from "../src/b1.ts";

// A missing sap_connection row is a seed gap, not a SAP outage. The old "SAP is not connected"
// copy hid `bun run seed:agent <slug>` behind a message that also covers a down Service Layer.

test("a tenant with no sap_connection is told the agent is not configured", async () => {
  const err = await agentTarget(crypto.randomUUID()).then(
    () => { throw new Error("expected agentTarget to reject"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ORPCError);
  const o = err as ORPCError;
  expect(o.code).toBe("SERVICE_UNAVAILABLE");
  expect(o.message).toBe(
    "No on-prem agent is configured for this workspace. Run seed:agent with the secret from agent.json.",
  );
});
