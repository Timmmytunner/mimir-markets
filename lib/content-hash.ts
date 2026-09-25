/**
 * Content hashing — SHA-256, the hash Stellar and Soroban actually speak.
 *
 * ── Why this replaces `keccak256(toBytes(x))` everywhere ─────────────────────
 *
 * The EVM-era code hashed with keccak256 because that is what Solidity's
 * `keccak256()` and EIP-191 message signing use, so an off-chain hash could be
 * recomputed on chain. On Soroban the on-chain primitive is
 * `env.crypto().sha256()` — there is no keccak in the host interface — so a
 * keccak digest can no longer be checked by a contract, and the client-side
 * equivalent of the host function is `hash()` from `@stellar/stellar-sdk`
 * (verified: `hash(Buffer.from("abc"))` → `ba7816bf…0015ad`, the SHA-256 of
 * "abc"). Both produce 32 bytes, so every `BytesN<32>` field — `evidence_hash`,
 * `context_hash` — takes the new digest unchanged.
 *
 * ── Hex form: no `0x` prefix ─────────────────────────────────────────────────
 *
 * `0x…` is an EVM convention. Stellar tooling (and `lib/contract.ts`'s own
 * `toHex`) writes bare lowercase hex, and `fromHex32` tolerates either, so this
 * emits bare hex and the values round-trip through the contract boundary.
 *
 * Digests here are NOT interchangeable with the keccak ones they replace. Any
 * hash persisted before the migration (an archived `evidence_hash`, a stored
 * `metadataHash`) will not match a freshly computed one — that is a data
 * migration question, not something this module can paper over.
 */
import { hash } from "@stellar/stellar-sdk";

/** Raw SHA-256 of a UTF-8 string or byte array. Always 32 bytes. */
export function sha256Bytes(data: string | Uint8Array): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return hash(bytes);
}

/** SHA-256 as 64 lowercase hex characters, unprefixed. */
export function sha256Hex(data: string | Uint8Array): string {
  return sha256Bytes(data).toString("hex");
}

/** 32 zero bytes in hex — the "no hash attached" sentinel the contract stores. */
export const ZERO_HASH_HEX = "0".repeat(64);

/** True when a string is a 32-byte hex digest (with or without an `0x` prefix). */
export function isHash32Hex(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(normalized);
}

/**
 * Decode a caller-supplied 32-byte digest.
 *
 * Unlike `Buffer.from(value, "hex")`, this rejects truncated, overlong, odd,
 * and non-hex input instead of partially decoding it. Contract write paths use
 * this at the trust boundary so malformed evidence can never be silently
 * committed as another value.
 */
export function decodeHash32Hex(value: string, field = "hash"): Buffer {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new TypeError(`${field} must be exactly 32 bytes (64 hexadecimal characters)`);
  }
  return Buffer.from(normalized, "hex");
}
