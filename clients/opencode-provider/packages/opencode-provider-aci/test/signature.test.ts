import { expect, test } from "bun:test";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as secp from "@noble/secp256k1";

import {
  fetchLegacySignature,
  latestCompletionReceiptId,
  verifyLegacyMessageSignature,
} from "../src/signature.ts";

// Signing needs the noble hash registry; verification (the code under test)
// only needs `recoverPublicKey` and stays configuration-free.
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, message) => hmac(sha256, key, message);

const secretKey = new Uint8Array(32).fill(1);

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addressOf(publicKey: Uint8Array): string {
  return `0x${toHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

/** Sign `text` exactly like the gateway's legacy `ecdsa` signer does. */
function signLegacy(text: string, key: Uint8Array): string {
  const encoded = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${encoded.length}`);
  const message = new Uint8Array(prefix.length + encoded.length);
  message.set(prefix);
  message.set(encoded, prefix.length);
  const recovered = secp.sign(keccak_256(message), key, {
    prehash: false,
    format: "recovered",
  });
  const ethereum = new Uint8Array(65);
  ethereum.set(recovered.subarray(1), 0);
  ethereum[64] = recovered[0]! + 27;
  return `0x${toHex(ethereum)}`;
}

const signer = addressOf(secp.getPublicKey(secretKey, false));

test("recovers the gateway signing address", () => {
  const text = "aa".repeat(32) + ":" + "bb".repeat(32);
  const signature = signLegacy(text, secretKey);

  const result = verifyLegacyMessageSignature({
    text,
    signature,
    signingAddress: signer,
  });

  expect(result.ok).toBe(true);
  expect(result.recoveredAddress).toBe(signer);
});

test("flags a mismatched signing address", () => {
  const text = "11".repeat(32) + ":" + "22".repeat(32);
  const signature = signLegacy(text, secretKey);

  const result = verifyLegacyMessageSignature({
    text,
    signature,
    signingAddress: "0x0000000000000000000000000000000000000000",
  });

  expect(result.ok).toBe(false);
  expect(result.recoveredAddress).toBe(signer);
});

test("flags a tampered message", () => {
  const text = "33".repeat(32) + ":" + "44".repeat(32);
  const signature = signLegacy(text, secretKey);

  const result = verifyLegacyMessageSignature({
    text: "33".repeat(32) + ":" + "45".repeat(32),
    signature,
    signingAddress: signer,
  });

  expect(result.ok).toBe(false);
});

test("rejects malformed signatures with a reason", () => {
  const malformed = verifyLegacyMessageSignature({
    text: "aabb",
    signature: "0x1234",
    signingAddress: signer,
  });
  expect(malformed.ok).toBe(false);
  expect(malformed.reason).toBeString();

  const text = "55".repeat(32) + ":" + "66".repeat(32);
  const signature = signLegacy(text, secretKey);
  const bytes = new Uint8Array(
    signature
      .slice(2)
      .match(/../g)!
      .map((chunk) => parseInt(chunk, 16)),
  );
  bytes[64] = 7;
  const unsupportedResult = verifyLegacyMessageSignature({
    text,
    signature: `0x${toHex(bytes)}`,
    signingAddress: signer,
  });
  expect(unsupportedResult.ok).toBe(false);
  expect(unsupportedResult.reason).toBeString();
});

test("picks the latest completed chat completion regardless of list order", () => {
  const exchanges = [
    {
      receiptId: "attestation",
      method: "POST",
      path: "/v1/attestation/report",
      recordedAt: 300,
      responseComplete: true,
    },
    {
      receiptId: "old",
      method: "POST",
      path: "/v1/chat/completions",
      recordedAt: 100,
      responseComplete: true,
    },
    {
      receiptId: "new",
      method: "POST",
      path: "/v1/chat/completions",
      recordedAt: 200,
      responseComplete: true,
    },
    {
      receiptId: "pending",
      method: "POST",
      path: "/v1/chat/completions",
      recordedAt: 400,
      responseComplete: false,
    },
  ];

  expect(latestCompletionReceiptId(exchanges)).toBe("new");
  expect(latestCompletionReceiptId(exchanges.slice(0, 1))).toBe("attestation");
  expect(latestCompletionReceiptId([])).toBeUndefined();
});

test("fetches the legacy signature under the gateway version prefix", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetcher = async (request: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(request),
      authorization: headers.get("authorization"),
    });
    return Response.json({
      text: "aa:bb",
      signature: "0x1234",
      signing_address: "0xabc",
      signing_algo: "ecdsa",
      receipt: { chat_id: "chat-1" },
    });
  };

  const payload = await fetchLegacySignature({
    baseURL: "https://gateway.example/v1",
    receiptId: "chat-1",
    authorization: "Bearer key",
    fetch: fetcher,
  });

  expect(calls).toEqual([
    { url: "https://gateway.example/v1/signature/chat-1", authorization: "Bearer key" },
  ]);
  expect(payload).toEqual({
    receiptId: "chat-1",
    text: "aa:bb",
    signature: "0x1234",
    signingAddress: "0xabc",
    signingAlgo: "ecdsa",
  });
});

test("reports signature endpoint failures instead of throwing", async () => {
  const notFound = await fetchLegacySignature({
    baseURL: "https://gateway.example/v1",
    receiptId: "missing",
    fetch: async () => new Response("nope", { status: 404 }),
  });
  expect(notFound.error).toBe("signature endpoint returned HTTP 404");
  expect(notFound.text).toBe("");

  const detailed = await fetchLegacySignature({
    baseURL: "https://gateway.example/v1",
    receiptId: "missing",
    fetch: async () =>
      Response.json(
        { error: { message: "receipt id (chat_id or receipt_id) not found or expired" } },
        { status: 404 },
      ),
  });
  expect(detailed.error).toBe(
    "signature endpoint returned HTTP 404: receipt id (chat_id or receipt_id) not found or expired",
  );

  const unreachable = await fetchLegacySignature({
    baseURL: "https://gateway.example/v1",
    receiptId: "missing",
    fetch: async () => {
      throw new Error("connection refused");
    },
  });
  expect(unreachable.error).toBe("connection refused");

  const malformed = await fetchLegacySignature({
    baseURL: "not a url",
    receiptId: "missing",
    fetch: async () => Response.json({}),
  });
  expect(malformed.error).toBeString();
});
