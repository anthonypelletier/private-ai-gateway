/** @jsxImportSource @opentui/solid */
import type { PanelInput } from "@opencode/plugin/tui/context";
import { Plugin, usePlugin } from "@opencode/plugin/tui";

import { createAciRpc } from "./rpc.ts";

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

export function createAciTuiPlugin(profile: AciTuiProfile) {
  const definition = createAciRpc(profile);
  const panelName = `aci-verify-${profile.providerId}`;
  const badge = `aci ${profile.providerId}`;

  return Plugin.define({
    id: `aci-tui-${profile.providerId}`,
    setup(context) {
      const rpc = context.client.rpc(definition);
      const [state, update] = context.storage.memory<AciTuiState>("status", {
        initial: initialState(profile),
      });

      const refresh = async () => {
        try {
          const [statusRaw, receiptsRaw] = await Promise.all([rpc.status({}), rpc.receipts({})]);
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
            draft.phase = "blocked";
            draft.error = error instanceof Error ? error.message : String(error);
          });
        }
      };

      void refresh();
      const stopEvents = rpc.events.on("changed", () => {
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
                    const result = (await rpc.refresh({})) as { phase?: string };
                    context.ui.toast.show({
                      message: `ACI verification: ${result.phase ?? "unknown"}`,
                      variant: result.phase === "verified" ? "success" : "warning",
                    });
                  } catch (error) {
                    context.ui.toast.show({
                      message: `ACI verification failed: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                      variant: "error",
                    });
                  }
                  await refresh();
                },
              },
            ],
          }));
          return <box />;
        },
      });

      return () => {
        stopEvents();
        stopPrompt();
        stopHome();
        stopPanel();
        stopCommands();
      };
    },
  });
}

function AciBadge(props: { state: AciTuiState; label: string }) {
  const context = usePlugin();
  const text = () => {
    if (props.state.phase === "verified") return `✓ ${props.label}`;
    if (props.state.phase === "connecting") return `… ${props.label}`;
    return `✗ ${props.label}`;
  };
  const color = () =>
    props.state.phase === "verified"
      ? themeColor(context, [["status", "success"], ["semantic", "success"], ["success"]], "green")
      : props.state.phase === "connecting"
        ? themeColor(context, [["status", "warning"], ["warning"]], "yellow")
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

  const verified = () => props.state.phase === "verified";
  const check = (ok: boolean) => (ok ? "✓" : "✗");
  const lineColor = (ok: boolean) => (ok ? success : danger);

  return (
    <box flexDirection="column" padding={1}>
      <text fg={lineColor(verified())}>
        {check(verified())} {verified() ? "Your chat is confidential." : "Not verified."}
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
      <text fg={muted}>r verify again · esc close</text>
    </box>
  );
}

export default createAciTuiPlugin(DEFAULT_ACI_TUI_PROFILE);
