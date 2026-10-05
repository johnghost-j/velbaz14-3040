import { useEffect, useRef, useState } from "react";

const TYPE_MS = 42;
const DELETE_MS = 22;
const HOLD_MS = 2200;

/**
 * Typewriter that cycles through phrases, used inside the prompt mock so the
 * product shot feels alive instead of being a screenshot. Ported from the
 * waitlist landing page.
 */
export function TypingText({
  phrases,
  className = "",
  active = true,
}: {
  phrases: string[];
  className?: string;
  active?: boolean;
}) {
  const [text, setText] = useState(phrases[0] ?? "");
  const [index, setIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const staticRef = useRef(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      staticRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!active || staticRef.current) return;
    const full = phrases[index] ?? "";

    if (!deleting && text === full) {
      const hold = window.setTimeout(() => setDeleting(true), HOLD_MS);
      return () => window.clearTimeout(hold);
    }
    if (deleting && text === "") {
      setDeleting(false);
      setIndex((value) => (value + 1) % phrases.length);
      return;
    }

    const next = window.setTimeout(
      () => {
        setText((value) =>
          deleting ? full.slice(0, value.length - 1) : full.slice(0, value.length + 1),
        );
      },
      deleting ? DELETE_MS : TYPE_MS + Math.random() * 46,
    );
    return () => window.clearTimeout(next);
  }, [active, deleting, index, phrases, text]);

  return (
    <span className={className}>
      {text}
      <span className="caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-wl-fg align-middle" />
    </span>
  );
}
