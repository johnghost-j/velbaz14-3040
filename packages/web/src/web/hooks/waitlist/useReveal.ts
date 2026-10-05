import { useEffect, useRef, useState } from "react";

/**
 * Reveals an element once it has reached the viewport, then stops watching.
 * Ported from the waitlist landing page.
 *
 * Uses IntersectionObserver rather than a `window` scroll listener: this
 * component renders inside `.velbaz-waitlist-landing`, which is itself
 * `position: fixed` + `overflow-y: auto` (it's the gate overlay covering the
 * whole app) — so it, not `window`, is what actually scrolls, and a
 * `window.addEventListener("scroll", …)` would never fire. IntersectionObserver
 * works regardless of which ancestor is the scroll container.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>({
  trigger = 0.92,
}: { trigger?: number } = {}) {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(true);
      return;
    }

    // trigger=0.92 in the old rect-vs-innerHeight math meant "revealed once
    // its top has crossed 92% down the viewport" — i.e. it only needs to be
    // barely poking into view. Express that as a rootMargin that pulls the
    // observer's bottom edge up so IntersectionObserver fires at the same
    // moment.
    const bottomMargin = Math.round((1 - trigger) * 100);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0, rootMargin: `0px 0px -${bottomMargin}% 0px` },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [trigger]);

  return { ref, shown };
}
