type LogoProps = {
  className?: string;
  /** Adds the split-apart hover reaction. Off for static marks like the footer. */
  reactive?: boolean;
  title?: string;
};

/**
 * The Velbaz mark: a geometric V built from two solid blocks — a near-vertical
 * left blade and a slanted right parallelogram — meeting at a single point.
 * Ported from the standalone waitlist landing page. Named `WaitlistLogo` to
 * avoid colliding with this app's own `VelbazIcon` component.
 */
export function WaitlistLogo({ className, reactive = false, title }: LogoProps) {
  return (
    <svg
      viewBox="0 0 300 240"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : "true"}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M97 25 L97 176 L60 228 L14 228 L14 73 Z"
        className={reactive ? "logo-blade-left" : undefined}
      />
      <path
        d="M203 12 L286 12 L181 173 L97 173 Z"
        className={reactive ? "logo-blade-right" : undefined}
      />
    </svg>
  );
}
