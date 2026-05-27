/**
 * PoB2 build code codec.
 *
 * Build code pipeline (per PoB2 docs):
 *   1. Build state is serialized to XML via Build:SaveDB()
 *   2. XML is compressed with Deflate
 *   3. Binary is base64-encoded
 *   4. URL-safe transform: '+' → '-', '/' → '_'
 *
 * This module reverses (decode) and replays (encode) that pipeline.
 */

import { deflate, deflateRaw, inflate, inflateRaw } from "pako";

/** Decode a PoB2 build code string into its raw XML payload. */
export function decodeBuildCode(buildCode: string): string {
  // 1. URL-safe → standard base64
  const standardB64 = buildCode.replace(/-/g, "+").replace(/_/g, "/");

  // 2. base64 → binary
  let compressed: Uint8Array;
  try {
    compressed = Uint8Array.from(Buffer.from(standardB64, "base64"));
  } catch (e) {
    throw new BuildCodecError("base64 decode failed", { cause: e });
  }

  // 3. inflate — PoB build codes use zlib-wrapped deflate (header bytes 0x78 0x9c).
  // Some older or tooling-generated codes may be raw deflate; try zlib first, fall back.
  let xmlBytes: Uint8Array;
  const firstByte = compressed[0];
  const looksLikeZlib = firstByte === 0x78; // 0x78 0x9c / 0x78 0xda / 0x78 0x01
  try {
    xmlBytes = looksLikeZlib ? inflate(compressed) : inflateRaw(compressed);
  } catch (e) {
    // First attempt failed — try the other format
    try {
      xmlBytes = looksLikeZlib ? inflateRaw(compressed) : inflate(compressed);
    } catch {
      throw new BuildCodecError("inflate failed (tried both zlib and raw deflate)", { cause: e });
    }
  }

  // 4. bytes → utf8
  return Buffer.from(xmlBytes).toString("utf8");
}

/**
 * Encode a raw XML payload back into a PoB2 build code string.
 *
 * Uses zlib-wrapped deflate (default for PoB codes — header bytes 0x78 0x9c)
 * unless `raw: true` is passed to use raw deflate (no zlib header).
 */
export function encodeBuildCode(xml: string, opts: { raw?: boolean } = {}): string {
  const xmlBytes = Buffer.from(xml, "utf8");
  const compressed = opts.raw ? deflateRaw(xmlBytes) : deflate(xmlBytes);
  const standardB64 = Buffer.from(compressed).toString("base64");
  return standardB64.replace(/\+/g, "-").replace(/\//g, "_");
}

export class BuildCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BuildCodecError";
    if (options?.cause) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
