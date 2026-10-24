import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { agentTarget, SAP_UNAVAILABLE } from "../src/b1.ts";

// A missing sap_connection row means nobody paired an agent yet, not a SAP outage — the message says
// where to pair one rather than a "SAP is not connected" that also covers a down Service Layer.

test("a tenant with no sap_connection is told the agent is not configured", async () => {
  const err = await agentTarget(crypto.randomUUID()).then(
    () => { throw new Error("expected agentTarget to reject"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ORPCError);
  const o = err as ORPCError;
  expect(o.code).toBe("SERVICE_UNAVAILABLE");
  expect(o.message).toBe(SAP_UNAVAILABLE);
});
