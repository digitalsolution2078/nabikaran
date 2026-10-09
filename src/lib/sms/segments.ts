/**
 * SMS segment estimation.
 *
 * GSM 03.38 7-bit messages: 160 chars single, 153 per part when concatenated.
 * Anything outside the GSM basic + extension set (all Devanagari) forces
 * UCS-2: 70 UTF-16 code units single, 67 per part when concatenated.
 *
 * This is an ESTIMATE used for reservations. The provider's reported unit
 * count is the source of truth at commit time (see dispatcher).
 */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

const basicSet = new Set(GSM_BASIC.split(""));
const extSet = new Set(GSM_EXT.split(""));

export type Encoding = "GSM-7" | "UCS-2";

export interface SegmentEstimate {
  encoding: Encoding;
  /** Length in the encoding's unit (septets for GSM-7, UTF-16 code units for UCS-2). */
  length: number;
  segments: number;
  singleLimit: number;
  perPartLimit: number;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!basicSet.has(ch) && !extSet.has(ch)) return false;
  }
  return true;
}

export function estimateSegments(text: string): SegmentEstimate {
  if (isGsm7(text)) {
    let septets = 0;
    for (const ch of text) septets += extSet.has(ch) ? 2 : 1;
    const segments = septets === 0 ? 1 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: "GSM-7", length: septets, segments, singleLimit: 160, perPartLimit: 153 };
  }
  const units = text.length; // UTF-16 code units
  const segments = units === 0 ? 1 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: "UCS-2", length: units, segments, singleLimit: 70, perPartLimit: 67 };
}
