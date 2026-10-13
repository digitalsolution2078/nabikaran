"use client";
import { useEffect, useRef, useState } from "react";
import { localizeNumber } from "@/lib/i18n/format";
import type { Lang } from "@/lib/i18n/dict";

/** A number that counts up from zero the first time it is shown. */
export function CountUp({ value, lang, duration = 900 }: { value: number; lang: Lang; duration?: number }) {
  const [shown, setShown] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || value === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    const run = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 4);
        setShown(Math.round(value * eased));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      setShown(0);
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting) { run(); io.disconnect(); } });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, duration]);
  return <span ref={ref} className="count-up">{localizeNumber(shown, lang)}</span>;
}
