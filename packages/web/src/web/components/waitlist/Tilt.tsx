import { type ReactNode, useRef } from "react";

/**
 * Pointer-reactive 3D tilt with a travelling sheen. Fine pointers only —
 * touch devices get the plain card. Ported from the waitlist landing page.
 */
export function Tilt({
  children,
  className = "",
  max = 6,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const node = ref.current;
    if (!node) return;
    if (
      !window.matchMedia("(pointer: fine)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    node.style.transform = `perspective(900px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg) translateY(-3px)`;
    node.style.setProperty("--sheen-x", `${px * 100}%`);
    node.style.setProperty("--sheen-y", `${py * 100}%`);
    node.style.setProperty("--sheen-o", "1");
  };

  const reset = () => {
    const node = ref.current;
    if (!node) return;
    node.style.transform = "";
    node.style.setProperty("--sheen-o", "0");
  };

  return (
    <div ref={ref} onPointerMove={onMove} onPointerLeave={reset} className={`tilt ${className}`}>
      {children}
    </div>
  );
}
