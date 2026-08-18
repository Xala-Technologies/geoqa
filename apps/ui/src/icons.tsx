import type { JSX } from "react";

type IconProps = {
  className?: string;
};

export function IconSun({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconMoon({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M16.5 13.5A7 7 0 0 1 10.2 4.2 7.2 7.2 0 1 0 19.8 13.8a7 7 0 0 1-3.3-.3Z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconGear({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M4.5 8.2h15M4.5 15.8h15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9" cy="8.2" r="1.7" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="15" cy="15.8" r="1.7" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function IconWorkspace({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M5 8.2h14v10.2H5V8.2ZM8 8.2V6.8A4 4 0 0 1 16 6.8v1.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconFolder({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M4.6 8.2h5.2l1.6 1.8h8V17.8H4.6V8.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconBook({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M6.2 5.6h11.6v13.2H8A1.8 1.8 0 0 1 6.2 17V5.6ZM9.4 8.4h5.8M9.4 11.4h5.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPeople({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.4 17.2c.4-2.4 2-3.6 3.6-3.6s3.2 1.2 3.6 3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="15.6" cy="9.4" r="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M14.8 13.8c1.4.2 2.6 1.2 3 3.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function IconTicket({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M5 8.2h14v3.2a2.2 2.2 0 0 0 0 4.4v3H5v-3a2.2 2.2 0 0 0 0-4.4V8.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPulse({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M4 12h3.2l1.8-4.4L12.6 17l2.2-5H20"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconClock({ className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 8v4.4l3 1.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function LiveDots(): JSX.Element {
  return (
    <span className="live-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

export type NavIcon = "workspace" | "pulse" | "ticket" | "book" | "people" | "folder" | "gear" | "clock";

export const NAV_ICONS: Record<NavIcon, JSX.Element> = {
  workspace: <IconWorkspace className="icon" />,
  pulse: <IconPulse className="icon" />,
  ticket: <IconTicket className="icon" />,
  book: <IconBook className="icon" />,
  people: <IconPeople className="icon" />,
  folder: <IconFolder className="icon" />,
  gear: <IconGear className="icon" />,
  clock: <IconClock className="icon" />,
};
