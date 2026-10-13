"use client";
import { useEffect, useState } from "react";

/**
 * Cycles through words with a slide-up transition. All words sit in the same
 * grid cell, so the line never jumps in width or height while it changes.
 */
export function RotatingWords({ words, interval = 2400 }: { words: string[]; interval?: number }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || words.length < 2) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % words.length), interval);
    return () => window.clearInterval(id);
  }, [words.length, interval]);
  return (
    <span className="rotator">
      <span className="sr-only">{words[0]}</span>
      {words.map((w, n) => (
        <span key={w} aria-hidden className={`rotator-word${n === i ? " on" : n === (i - 1 + words.length) % words.length ? " off" : ""}`}>{w}</span>
      ))}
    </span>
  );
}
