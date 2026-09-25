import { Rpc } from "@opencode/plugin/rpc";

import type { AciProviderProfile } from "@phala/aci-provider";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function object(properties: Record<string, unknown>, required: readonly string[] = []): any {
  return { type: "object", properties, required, additionalProperties: false };
}

const receipt = object(
  {
    receiptId: { type: "string" },
    method: { type: "string" },
    path: { type: "string" },
    status: { type: "integer" },
    complete: { type: "boolean" },
    recordedAt: { type: "integer" },
  },
  ["receiptId", "method", "path", "status", "complete", "recordedAt"],
);

const identity = object(
  {
    origin: { type: "string" },
    apiVersion: { type: "string" },
    composeHash: { type: "string" },
    releasePinned: { type: "boolean" },
    keysetDigest: { type: "string" },
    tlsSpkiPins: { type: "array", items: { type: "string" } },
    verifiedAt: { type: "integer" },
    expiresAt: { type: "integer" },
  },
  [
    "origin",
    "apiVersion",
    "composeHash",
    "releasePinned",
    "keysetDigest",
    "tlsSpkiPins",
    "verifiedAt",
    "expiresAt",
  ],
);

/**
 * RPC shared by the server plugin (registration) and the TUI plugin (client),
 * so the terminal can read the verified ACI state that lives in the server.
 */
export function createAciRpc(profile: Pick<AciProviderProfile, "providerId" | "label">) {
  return Rpc.define({
    id: `aci-${profile.providerId}`,
    methods: {
      status: {
        input: object({}),
        output: object(
          {
            providerID: { type: "string" },
            label: { type: "string" },
            phase: { type: "string" },
            error: { type: "string" },
            modelCount: { type: "integer" },
            receiptCount: { type: "integer" },
            identity,
          },
          ["providerID", "label", "phase", "modelCount", "receiptCount"],
        ),
      },
      attestation: {
        input: object({}),
        output: object({ text: { type: "string" } }, ["text"]),
      },
      receipts: {
        input: object({}),
        output: object({ items: { type: "array", items: receipt } }, ["items"]),
      },
      receipt: {
        input: object({ id: { type: "string" } }),
        output: object({ text: { type: "string" } }, ["text"]),
      },
      session: {
        input: object({ id: { type: "string" } }, ["id"]),
        output: object({ text: { type: "string" } }, ["text"]),
      },
      refresh: {
        input: object({}),
        output: object({ phase: { type: "string" } }, ["phase"]),
      },
    },
    events: {
      changed: { schema: object({ phase: { type: "string" } }, ["phase"]) },
    },
  });
}

export type AciRpc = ReturnType<typeof createAciRpc>;
