"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * One small client script for the whole site's motion:
 *  - elements with `data-reveal` fade/slide in when they scroll into view
 *    (children with `data-reveal-stagger` get a staggered delay),
 *  - `.glow` cards follow the pointer with a soft spotlight,
 *  - <html data-scrolled> is set once the page is scrolled (compact header).
 * With "reduce motion" on, everything is shown immediately.
 */
export function MotionRoot() {
  const path = usePathname();

  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const show = (el: Element) => el.classList.add("is-in");
    const tag = (scope: ParentNode) => {
      scope.querySelectorAll<HTMLElement>("[data-reveal-stagger]").forEach((group) => {
        Array.from(group.children).forEach((c, i) => (c as HTMLElement).style.setProperty("--i", String(i)));
      });
      return Array.from(scope.querySelectorAll("[data-reveal]:not(.is-in)"));
    };
    if (reduce || !("IntersectionObserver" in window)) {
      tag(document).forEach(show);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    tag(document).forEach((el) => io.observe(el));
    const mo = new MutationObserver(() => tag(document).forEach((el) => io.observe(el)));
    mo.observe(document.body, { childList: true, subtree: true });

    const onScroll = () => root.toggleAttribute("data-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const onMove = (ev: PointerEvent) => {
      const card = (ev.target as Element | null)?.closest?.(".glow") as HTMLElement | null;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
      card.style.setProperty("--my", `${ev.clientY - r.top}px`);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("pointermove", onMove);
    };
  }, [path]);

  return null;
}
