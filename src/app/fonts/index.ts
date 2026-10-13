import localFont from "next/font/local";

/**
 * Self-hosted fonts (no request to Google at runtime or build time).
 * Latin: Plus Jakarta Sans (variable 400–800). Devanagari: Mukta, loaded only
 * when the page shows Devanagari text (unicode-range), so English pages stay light.
 */
export const jakarta = localFont({
  src: [{ path: "./PlusJakartaSans-latin-400-800.woff2", weight: "400 800", style: "normal" }],
  variable: "--font-latin",
  display: "swap",
  // No system fallbacks here: they would cover Devanagari before Mukta gets a chance.
  fallback: [],
});

export const mukta = localFont({
  src: [
    { path: "./Mukta-devanagari-400.woff2", weight: "400", style: "normal" },
    { path: "./Mukta-devanagari-600.woff2", weight: "600", style: "normal" },
    { path: "./Mukta-devanagari-700.woff2", weight: "700", style: "normal" },
    { path: "./Mukta-devanagari-800.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-deva",
  display: "swap",
  preload: false,
  declarations: [{ prop: "unicode-range", value: "U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+25CC, U+A830-A839, U+A8E0-A8FF" }],
  fallback: ["Noto Sans Devanagari", "Nirmala UI", "sans-serif"],
});
