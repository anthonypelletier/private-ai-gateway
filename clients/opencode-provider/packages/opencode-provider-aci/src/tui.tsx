/** @jsxImportSource @opentui/solid */
import type { PanelInput } from "@opencode/plugin/tui/context";
import { Plugin, usePlugin } from "@opencode/plugin/tui";

import { createAciRpc } from "./rpc.ts";
import type { LegacyMessageCheck } from "./signature.ts";
import { verifyLegacyMessageSignature } from "./signature.ts";

declare global {
  namespace JSX {
    type Element = any;
    interface IntrinsicElements {
      [name: string]: any;
    }
  }
}

export interface AciTuiProfile {
  providerId: string;
  label: string;
}

/** Vendor-neutral terminal profile, loaded when the neutral package is installed. */
export const DEFAULT_ACI_TUI_PROFILE: AciTuiProfile = {
  providerId: "aci",
  label: "Private AI Gateway",
};

export interface AciTuiState {
  providerID: string;
  label: string;
  phase: string;
  error: string;
  modelCount: number;
  receiptCount: number;
  origin: string;
  apiVersion: string;
  composeHash: string;
  releasePinned: boolean;
  keysetDigest: string;
  tlsSpkiPins: string[];
  verifiedAt: number;
  expiresAt: number;
  receipts: { id: string; label: string; complete: boolean; at: number }[];
}

interface AciStatusPayload {
  providerID: string;
  label: string;
  phase: string;
  error?: string;
  modelCount: number;
  receiptCount: number;
  identity?: {
    origin: string;
    apiVersion: string;
    composeHash: string;
    releasePinned: boolean;
    keysetDigest: string;
    tlsSpkiPins: string[];
    verifiedAt: number;
    expiresAt: number;
  };
}

interface AciReceiptsPayload {
  items: {
    receiptId: string;
    method: string;
    path: string;
    status: number;
    complete: boolean;
    recordedAt: number;
  }[];
}

export interface AciSignaturePayload {
  receiptId: string;
  text?: string;
  signature?: string;
  signingAddress?: string;
  signingAlgo?: string;
  error?: string;
}

function initialState(profile: AciTuiProfile): AciTuiState {
  return {
    providerID: profile.providerId,
    label: profile.label,
    phase: "connecting",
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
  };
}

type ThemeLike = Record<string, unknown>;

function themeColor(
  context: { theme: unknown },
  paths: readonly (readonly string[])[],
  fallback: string,
): string {
  for (const path of paths) {
    let value: unknown = context.theme;
    for (const key of path) {
      value = typeof value === "object" && value !== null ? (value as ThemeLike)[key] : undefined;
    }
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

function short(value: string, size = 10): string {
  return value.length <= size ? value : `${value.slice(0, size)}…`;
}

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "unknown";
}

/** RPC failures arrive as tagged error objects, not Error instances. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
    if (typeof record.type === "string" && record.type.length > 0) return record.type;
    try {
      return JSON.stringify(record).slice(0, 200);
    } catch {
      return "unknown error";
    }
  }
  return String(error);
}

export function createAciTuiPlugin(profile: AciTuiProfile) {
  const definition = createAciRpc(profile);
  const panelName = `aci-verify-${profile.providerId}`;
  const badge = `aci ${profile.providerId}`;

  return Plugin.define({
    id: `aci-tui-${profile.providerId}`,
    setup(context) {
      const rpc = context.client.rpc(definition);
      const location = context.location ?? context.data.location.default();
      const [state, update] = context.storage.memory<AciTuiState>("status", {
        initial: initialState(profile),
      });

      const refresh = async () => {
        try {
          const [statusRaw, receiptsRaw] = await Promise.all([
            rpc.status({}, { location }),
            rpc.receipts({}, { location }),
          ]);
          const status = statusRaw as AciStatusPayload;
          const receipts = receiptsRaw as AciReceiptsPayload;
          update((draft) => {
            draft.providerID = status.providerID;
            draft.label = status.label;
            draft.phase = status.phase;
            draft.error = status.error ?? "";
            draft.modelCount = status.modelCount;
            draft.receiptCount = status.receiptCount;
            const identity = status.identity;
            draft.origin = identity?.origin ?? "";
            draft.apiVersion = identity?.apiVersion ?? "";
            draft.composeHash = identity?.composeHash ?? "";
            draft.releasePinned = identity?.releasePinned ?? false;
            draft.keysetDigest = identity?.keysetDigest ?? "";
            draft.tlsSpkiPins = [...(identity?.tlsSpkiPins ?? [])];
            draft.verifiedAt = identity?.verifiedAt ?? 0;
            draft.expiresAt = identity?.expiresAt ?? 0;
            draft.receipts = receipts.items.map((item) => ({
              id: item.receiptId,
              label: `${item.method} ${item.path} HTTP ${item.status}`,
              complete: item.complete,
              at: item.recordedAt,
            }));
          });
        } catch (error) {
          update((draft) => {
            // The server may simply not have this provider loaded for the
            // current location yet; keep it distinct from a blocked gateway.
            draft.phase = "unreachable";
            draft.error = errorText(error);
          });
        }
      };

      void refresh();
      // Recover automatically once the server activates this location's plugin
      // or finishes a slow verification.
      const poll = setInterval(() => {
        void refresh();
      }, 5000);
      const stopEvents = rpc.events.on("changed", (event) => {
        const eventLocation = (event as { location?: { directory?: string } }).location;
        if (eventLocation?.directory && eventLocation.directory !== location.directory) return;
        void refresh();
      });

      const stopPrompt = context.ui.slot({
        append: "prompt.footer.status",
        render: () => <AciBadge state={state} label={badge} />,
      });
      const stopHome = context.ui.slot({
        append: "home.footer.status",
        render: () => <AciBadge state={state} label={badge} />,
      });
      const stopPanel = context.ui.slot({
        append: "session.panel",
        render: (panel) =>
          panel.name === panelName ? (
            <AciPanel panel={panel} state={state} profile={profile} />
          ) : (
            <box />
          ),
      });

      const openCommand = `${definition.id}.open`;
      const refreshCommand = `${definition.id}.refresh`;
      const signatureCommand = `${definition.id}.signature`;

      // Mirror the RedPill "Message Verification" view: fetch the legacy
      // per-message signature through the verified transport and check it
      // locally against the reported signing address.
      const showSignature = async (receiptId?: string) => {
        try {
          const payload = (await rpc.signature(receiptId ? { receiptId } : {}, {
            location,
          })) as AciSignaturePayload;
          if (payload.error || !payload.text || !payload.signature || !payload.signingAddress) {
            context.ui.toast.show({
              message: `ACI message signature: ${payload.error ?? "unavailable"}`,
              variant: "warning",
            });
            return;
          }
          const result = verifyLegacyMessageSignature({
            text: payload.text,
            signature: payload.signature,
            signingAddress: payload.signingAddress,
          });
          context.ui.dialog.show(() => (
            <AciSignatureDialog context={context} payload={payload} result={result} />
          ));
        } catch (error) {
          context.ui.toast.show({
            message: `ACI message signature failed: ${errorText(error)}`,
            variant: "error",
          });
        }
      };

      // Keymap layers belong to a component scope, so register them from a
      // slot render instead of setup; the CLI mounts its keymap provider above
      // the app slot.
      const stopCommands = context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global",
            priority: 10,
            commands: [
              {
                id: openCommand,
                title: `Open ${profile.label} verification center`,
                group: "ACI",
                slash: { name: "aci" },
                palette: true,
                suggested: true,
                run: () => {
                  context.ui.panel.open(panelName);
                  void refresh();
                },
              },
              {
                id: refreshCommand,
                title: `Verify ${profile.label} again`,
                group: "ACI",
                bind: "r",
                enabled: () => context.ui.panel.current()?.name === panelName,
                run: async () => {
                  try {
                    const result = (await rpc.refresh({}, { location })) as { phase?: string };
                    context.ui.toast.show({
                      message: `ACI verification: ${result.phase ?? "unknown"}`,
                      variant: result.phase === "verified" ? "success" : "warning",
                    });
                  } catch (error) {
                    context.ui.toast.show({
                      message: `ACI verification failed: ${errorText(error)}`,
                      variant: "error",
                    });
                  }
                  await refresh();
                },
              },
              {
                id: signatureCommand,
                title: `Show ${profile.label} message signature`,
                group: "ACI",
                slash: { name: "aci-signature" },
                palette: true,
                run: () => {
                  void showSignature();
                },
              },
              {
                id: `${signatureCommand}.panel`,
                title: `Show ${profile.label} message signature`,
                group: "ACI",
                bind: "s",
                enabled: () => context.ui.panel.current()?.name === panelName,
                run: () => {
                  void showSignature();
                },
              },
            ],
          }));
          return <box />;
        },
      });

      return () => {
        clearInterval(poll);
        stopEvents();
        stopPrompt();
        stopHome();
        stopPanel();
        stopCommands();
      };
    },
  });
}

/** Split long hex blobs so the dialog can show every byte without clipping. */
function wrapHex(value: string, width = 64): string[] {
  if (value.length === 0) return [""];
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return lines;
}

export function AciSignatureDialog(props: {
  context: Plugin.Context;
  payload: AciSignaturePayload;
  result: LegacyMessageCheck;
}) {
  const success = themeColor(
    props.context,
    [["status", "success"], ["semantic", "success"], ["success"]],
    "green",
  );
  const danger = themeColor(
    props.context,
    [["status", "error"], ["semantic", "error"], ["error"]],
    "red",
  );
  const muted = themeColor(
    props.context,
    [
      ["text", "muted"],
      ["text", "subtle"],
    ],
    "gray",
  );

  return (
    <box flexDirection="column" padding={1}>
      <text fg={muted}>Message Verification</text>
      <text fg={props.result.ok ? success : danger}>
        {props.result.ok
          ? "✓ Message verified"
          : `✗ Signature not verified${props.result.reason ? `: ${props.result.reason}` : ""}`}
      </text>

      <text> </text>
      <text>Signing address</text>
      <text fg={muted}>{props.payload.signingAddress ?? ""}</text>
      {!props.result.ok && props.result.recoveredAddress ? (
        <box flexDirection="column">
          <text>Recovered address</text>
          <text fg={danger}>{props.result.recoveredAddress}</text>
        </box>
      ) : null}

      <text> </text>
      <text>Message</text>
      {wrapHex(props.payload.text ?? "").map((line) => (
        <text fg={muted}>{line}</text>
      ))}

      <text> </text>
      <text>Signature</text>
      {wrapHex(props.payload.signature ?? "").map((line) => (
        <text fg={muted}>{line}</text>
      ))}

      <text> </text>
      <text fg={muted}>
        Algorithm {props.payload.signingAlgo ?? "unknown"} · receipt {props.payload.receiptId}
      </text>
      <text fg={muted}>
        The signature covers request_hash:response_hash. The signer is recovered locally and
        compared with the address the gateway reports over the pinned transport; the receipt keeps
        its own verification path.
      </text>
      <text> </text>
      <text fg={muted}>esc close</text>
    </box>
  );
}

function AciBadge(props: { state: AciTuiState; label: string }) {
  const context = usePlugin();
  const text = () => {
    if (props.state.phase === "verified") return `✓ ${props.label}`;
    if (props.state.phase === "connecting") return `… ${props.label}`;
    if (props.state.phase === "unreachable") return `? ${props.label}`;
    return `✗ ${props.label}`;
  };
  const color = () =>
    props.state.phase === "verified"
      ? themeColor(context, [["status", "success"], ["semantic", "success"], ["success"]], "green")
      : props.state.phase === "connecting"
        ? themeColor(context, [["status", "warning"], ["warning"]], "yellow")
        : props.state.phase === "unreachable"
          ? themeColor(
              context,
              [
                ["text", "muted"],
                ["text", "subtle"],
              ],
              "gray",
            )
          : themeColor(context, [["status", "error"], ["error"]], "red");
  return <text fg={color()}> ACI {text()} </text>;
}

function AciPanel(props: { panel: PanelInput; state: AciTuiState; profile: AciTuiProfile }) {
  const context = usePlugin();
  const success = themeColor(
    context,
    [["status", "success"], ["semantic", "success"], ["success"]],
    "green",
  );
  const danger = themeColor(
    context,
    [["status", "error"], ["semantic", "error"], ["error"]],
    "red",
  );
  const muted = themeColor(
    context,
    [
      ["text", "muted"],
      ["text", "subtle"],
    ],
    "gray",
  );
  const warning = themeColor(
    context,
    [["status", "warning"], ["semantic", "warning"], ["warning"]],
    "yellow",
  );

  const verified = () => props.state.phase === "verified";
  const connecting = () => props.state.phase === "connecting";
  const unreachable = () => props.state.phase === "unreachable";
  const summary = () =>
    verified()
      ? "Your chat is confidential."
      : unreachable()
        ? "ACI server state unavailable."
        : connecting()
          ? "Verifying the gateway…"
          : "Not verified.";
  const check = (ok: boolean) => (ok ? "✓" : connecting() ? "…" : unreachable() ? "?" : "✗");
  const lineColor = (ok: boolean) =>
    ok ? success : connecting() ? warning : unreachable() ? muted : danger;

  return (
    <box flexDirection="column" padding={1}>
      <text fg={lineColor(verified())}>
        {check(verified())} {summary()}
      </text>
      <text fg={muted}>
        {props.profile.label}
        {props.state.origin ? ` · ${props.state.origin}` : ""}
      </text>
      {props.state.error ? <text fg={danger}>{props.state.error}</text> : null}

      <text> </text>
      <text fg={lineColor(props.state.tlsSpkiPins.length > 0)}>
        {check(props.state.tlsSpkiPins.length > 0)} End-to-end private ·{" "}
        {props.state.tlsSpkiPins.length} TLS SPKI pin(s)
      </text>
      <text fg={lineColor(verified() && props.state.composeHash.length > 0)}>
        {check(props.state.composeHash.length > 0)} Verified software ·{" "}
        {props.state.composeHash ? short(props.state.composeHash, 16) : "no compose hash"}
        {props.state.releasePinned ? " (release pinned)" : ""}
      </text>
      <text fg={lineColor(verified())}>
        {check(verified())} Confidential hardware ·{" "}
        {props.state.apiVersion ? `${props.state.apiVersion} attestation` : "no report"}
      </text>

      <text> </text>
      <text fg={muted}>Keyset {short(props.state.keysetDigest, 20)}</text>
      <text fg={muted}>
        Verified {when(props.state.verifiedAt)} · expires {when(props.state.expiresAt)}
      </text>
      <text fg={muted}>
        Models {props.state.modelCount} · receipts {props.state.receiptCount}
      </text>

      <text> </text>
      <text>Recent receipts</text>
      {props.state.receipts.length === 0 ? (
        <text fg={muted}>No receipt recorded in this process.</text>
      ) : (
        props.state.receipts
          .slice(0, 5)
          .map((item) => (
            <text>{`${item.complete ? "✓" : "…"} ${short(item.id, 12)} ${item.label}`}</text>
          ))
      )}

      <text> </text>
      <text fg={muted}>s message signature · r verify again · esc close</text>
    </box>
  );
}

export default createAciTuiPlugin(DEFAULT_ACI_TUI_PROFILE);
