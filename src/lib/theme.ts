/** Appearance preference, kept in a cookie so the first paint already has the right theme. */
export const THEME_COOKIE = "nb_theme";
export type Theme = "light" | "dark" | "system";
export function parseTheme(v: string | undefined | null): Theme {
  return v === "dark" || v === "system" ? v : "light";
}
