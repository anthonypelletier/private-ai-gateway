import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import { testRender } from "@opentui/solid";

import { AciPanel, AciSignatureDialog, sessionUsesProvider } from "../src/tui.tsx";

const payload = {
  receiptId: "chatcmpl-test",
  text: `${"aa".repeat(32)}:${"bb".repeat(32)}`,
  signature: `0x${"cc".repeat(65)}`,
  signingAddress: `0x${"dd".repeat(20)}`,
  signingAlgo: "ecdsa",
};

test("only claims verification for sessions on this provider", () => {
  expect(sessionUsesProvider({ model: { providerID: "redpill" } }, "redpill")).toBe(true);
  expect(sessionUsesProvider({ model: { providerID: "anthropic" } }, "redpill")).toBe(false);
  expect(sessionUsesProvider({}, "redpill")).toBe(false);
  expect(sessionUsesProvider(undefined, "redpill")).toBe(false);
});

test("panel names the provider the session actually uses", async () => {
  const setup = await testRender(
    () =>
      AciPanel({
        context: { theme: {} } as unknown as Plugin.Context,
        panel: {
          name: "aci-verify-redpill",
          sessionID: "ses_test",
          width: 80,
          presentation: "panel",
          focused: false,
          focus: () => {},
          close: () => {},
          toggleFullscreen: () => {},
        },
        state: {
          providerID: "redpill",
          label: "RedPill AI",
          phase: "unreachable",
          error: "",
          modelCount: 0,
          receiptCount: 0,
          origin: "",
          apiVersion: "",
          composeHash: "",
          releasePinned: false,
          keysetDigest: "",
          tlsSpkiPins: [],
          verifiedAt: 0,
          expiresAt: 0,
          receipts: [],
        },
        profile: { providerId: "redpill", label: "RedPill AI" },
        sessionIsAci: false,
      }),
    { width: 120, height: 40 },
  );
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("This session is not using RedPill AI.");
  } finally {
    setup.renderer.destroy();
  }
});

test("renders the message verification dialog", async () => {
  const setup = await testRender(
    () =>
      AciSignatureDialog({
        context: { theme: {} } as unknown as Plugin.Context,
        payload,
        result: { ok: true, recoveredAddress: payload.signingAddress },
      }),
    { width: 120, height: 40 },
  );
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Message Verification");
    expect(frame).toContain("Message verified");
    expect(frame).toContain(payload.signingAddress);
    expect(frame).toContain(payload.text.slice(0, 64));
    expect(frame).toContain(payload.signature.slice(0, 64));
    expect(frame).toContain("Algorithm ecdsa");
  } finally {
    setup.renderer.destroy();
  }
});

test("marks an unrecoverable signature", async () => {
  const setup = await testRender(
    () =>
      AciSignatureDialog({
        context: { theme: {} } as unknown as Plugin.Context,
        payload,
        result: {
          ok: false,
          recoveredAddress: `0x${"ee".repeat(20)}`,
          reason: "unsupported recovery id",
        },
      }),
    { width: 120, height: 40 },
  );
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Signature not verified: unsupported recovery id");
    expect(frame).toContain(`0x${"ee".repeat(20)}`);
  } finally {
    setup.renderer.destroy();
  }
});
