import { encode } from "fast-png";

/**
 * Encode a raw RGBA buffer as a PNG (V3, ADR 0080 §9).
 *
 * PDFium's own `EPDF_PNG_EncodeRGBA` would remove this dependency, and both S6
 * and V3's T5 probed it; see ADR 0080's *Consequences* for what it returned.
 * `fast-png` is pure JS with no native code, so it adds no build step and no
 * platform matrix — the same properties that made the WASM renderer the choice.
 */
export function encodeRgbaPng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  return encode({ width, height, channels: 4, data: rgba });
}

/**
 * PDFium's bitmaps are **BGRA**; PNG wants RGBA. Swaps the two in place and
 * returns the same buffer — the caller always owns a fresh copy of the WASM
 * heap slice, so there is nothing else looking at it.
 */
export function bgraToRgba(buffer: Uint8Array): Uint8Array {
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    const b = buffer[i] as number;
    buffer[i] = buffer[i + 2] as number;
    buffer[i + 2] = b;
  }
  return buffer;
}
