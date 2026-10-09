import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Architectural boundary (docs/MCP_ARCHITECTURE.md §3/§7): the shared core must
 * be transport-agnostic and must never reach provider credentials, payment
 * gateways, the dispatcher or admin functions. The same rule will apply to
 * src/app/mcp/** once it exists.
 */
const ROOT = path.resolve(__dirname, "..");
const FORBIDDEN = [
  /from\s+["'][^"']*providers\//,
  /from\s+["'][^"']*payments\//,
  /from\s+["'][^"']*services\/(admin|dispatcher|payments)/,
  /from\s+["']next\//,
  /from\s+["']next["']/,
  /env\.aakash/,
  /env\.khalti/,
  /workerToken/,
];

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

describe("import boundary", () => {
  for (const dir of ["src/lib/core", "src/app/mcp"]) {
    it(`${dir} never imports providers, payments, dispatcher, admin or next/*`, () => {
      const files = walk(path.join(ROOT, dir));
      const violations: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        for (const re of FORBIDDEN) if (re.test(src)) violations.push(`${path.relative(ROOT, f)}: ${re}`);
      }
      expect(violations).toEqual([]);
    });
  }
  it("core exists and is non-empty", () => {
    expect(walk(path.join(ROOT, "src/lib/core")).length).toBeGreaterThan(5);
  });
});
