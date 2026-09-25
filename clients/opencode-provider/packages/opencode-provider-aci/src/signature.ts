import { keccak_256 } from "@noble/hashes/sha3.js";
import { recoverPublicKey } from "@noble/secp256k1";

export interface LegacyMessageSignature {
  /** `request_hash:response_hash` signed by the gateway. */
  text: string;
  /** `0x`-prefixed 65-byte secp256k1 signature (r ‖ s ‖ v, v = recovery + 27). */
  signature: string;
  /** `0x`-prefixed Ethereum address the gateway reports as the signer. */
  signingAddress: string;
}

export interface LegacyMessageCheck {
  ok: boolean;
  recoveredAddress: string;
  reason?: string;
}

export interface LegacySignaturePayload {
  receiptId: string;
  text: string;
  signature: string;
  signingAddress: string;
  signingAlgo: string;
  error?: string;
}

export interface RecordedExchangeLike {
  receiptId: string;
  method: string;
  path: string;
  recordedAt: number;
  responseComplete: boolean;
}

/**
 * Pick the receipt whose legacy signature best represents "the last message":
 * the most recent completed chat completion, falling back to the most recent
 * recorded exchange. Recorded history order is ignored.
 */
export function latestCompletionReceiptId(
  exchanges: readonly RecordedExchangeLike[],
): string | undefined {
  const byTime = [...exchanges].sort((left, right) => right.recordedAt - left.recordedAt);
  const completion = byTime.find(
    (entry) =>
      entry.responseComplete &&
      entry.method.toUpperCase() === "POST" &&
      entry.path.includes("chat/completions"),
  );
  return (completion ?? byTime[0])?.receiptId;
}

/**
 * Fetch the gateway's legacy per-message signature for a receipt id (or chat
 * id) through an already-verified transport. The caller supplies the bearer
 * token observed on model requests because the legacy endpoint authenticates
 * the receipt owner.
 */
export async function fetchLegacySignature(input: {
  baseURL: string;
  receiptId: string;
  authorization?: string;
  fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<LegacySignaturePayload> {
  const empty: LegacySignaturePayload = {
    receiptId: input.receiptId,
    text: "",
    signature: "",
    signingAddress: "",
    signingAlgo: "",
  };
  try {
    const url = new URL(input.baseURL);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/signature/${encodeURIComponent(input.receiptId)}`;
    url.search = "";
    const response = await input.fetch(url, {
      headers: {
        accept: "application/json",
        ...(input.authorization ? { authorization: input.authorization } : {}),
      },
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as Record<string, unknown>;
        const error = body.error;
        if (typeof error === "string") {
          detail = error;
        } else if (
          typeof error === "object" &&
          error !== null &&
          typeof (error as { message?: unknown }).message === "string"
        ) {
          detail = (error as { message: string }).message;
        }
      } catch {
        // Non-JSON error body: the status alone is the message.
      }
      return {
        ...empty,
        error: detail
          ? `signature endpoint returned HTTP ${response.status}: ${detail}`
          : `signature endpoint returned HTTP ${response.status}`,
      };
    }
    const value = (await response.json()) as Record<string, unknown>;
    return {
      receiptId: input.receiptId,
      text: typeof value.text === "string" ? value.text : "",
      signature: typeof value.signature === "string" ? value.signature : "",
      signingAddress: typeof value.signing_address === "string" ? value.signing_address : "",
      signingAlgo: typeof value.signing_algo === "string" ? value.signing_algo : "",
    };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hexToBytes(hex: string, size?: number): Uint8Array | undefined {
  const value = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (value.length % 2 !== 0 || (size !== undefined && value.length !== size * 2)) {
    return undefined;
  }
  if (!/^[0-9a-fA-F]*$/.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Recover the signer of the gateway's legacy message signature and compare it
 * with the reported signing address. The signed message is
 * `request_hash:response_hash` under the Ethereum personal-message prefix.
 */
export function verifyLegacyMessageSignature(input: LegacyMessageSignature): LegacyMessageCheck {
  const signature = hexToBytes(input.signature, 65);
  if (!signature) return { ok: false, recoveredAddress: "", reason: "invalid signature hex" };
  if (!input.text) return { ok: false, recoveredAddress: "", reason: "empty signed message" };
  const recovery = signature[64]! - 27;
  if (recovery !== 0 && recovery !== 1) {
    return { ok: false, recoveredAddress: "", reason: "unsupported recovery id" };
  }
  const noble = new Uint8Array(65);
  noble[0] = recovery;
  noble.set(signature.subarray(0, 64), 1);
  const encoded = new TextEncoder().encode(input.text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${encoded.length}`);
  const message = new Uint8Array(prefix.length + encoded.length);
  message.set(prefix);
  message.set(encoded, prefix.length);
  const hash = keccak_256(message);
  let recovered: Uint8Array;
  try {
    recovered = recoverPublicKey(noble, hash, { prehash: false, isCompressed: false });
  } catch (error) {
    return {
      ok: false,
      recoveredAddress: "",
      reason: error instanceof Error ? error.message : "signature recovery failed",
    };
  }
  const digest = keccak_256(recovered.subarray(1));
  const recoveredAddress = `0x${Array.from(digest.subarray(12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  return {
    ok: recoveredAddress.toLowerCase() === input.signingAddress.trim().toLowerCase(),
    recoveredAddress,
  };
}
