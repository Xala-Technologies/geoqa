/**
 * One sidebar, three groups. The old mode rail hid Compare and Setup
 * until you remembered they were a second column.
 */
import type { NavIcon } from "./icons.tsx";
import type { ViewId } from "./route.ts";

export type NavSectionId = "operate" | "compare" | "setup";

export interface NavItemDef {
  id: ViewId;
  label: string;
  hint: string;
  purpose: string;
  icon: NavIcon;
  section: NavSectionId;
}

export interface NavLink {
  id: string;
  href: string;
  label: string;
  hint: string;
  icon: NavIcon;
  current: boolean;
  count?: number;
  alert?: boolean;
}

export interface NavSection {
  id: NavSectionId;
  label: string;
  hint: string;
  links: NavLink[];
}

export const NAV_ITEMS: NavItemDef[] = [
  {
    id: "overview",
    label: "At a glance",
    hint: "Briefing",
    purpose: "A briefing. The work is Visits.",
    icon: "workspace",
    section: "operate",
  },
  {
    id: "live",
    label: "Now",
    hint: "On screen now",
    purpose: "A visit happening right now. You watch. You do not drive.",
    icon: "pulse",
    section: "operate",
  },
  {
    id: "runs",
    label: "Visits",
    hint: "Finished evidence",
    purpose: "Every finished visit. Open one to see what it did and the frames it kept.",
    icon: "ticket",
    section: "operate",
  },
  {
    id: "findings",
    label: "To fix",
    hint: "Tickets to fix",
    purpose: "Checks that failed. One row per site — the same grouping as the GitHub issue.",
    icon: "book",
    section: "operate",
  },
  {
    id: "geography",
    label: "By market",
    hint: "Same page, different city",
    purpose: "The same page from different cities. Open a city. Compare two.",
    icon: "people",
    section: "compare",
  },
  {
    id: "coverage",
    label: "Gaps",
    hint: "Never measured",
    purpose: "Cities and pages nobody has visited yet.",
    icon: "folder",
    section: "compare",
  },
  {
    id: "trends",
    label: "Over time",
    hint: "Direction of a metric",
    purpose: "Whether a number is drifting. Open a series, then the visit. A drift is not a ticket.",
    icon: "pulse",
    section: "compare",
  },
  {
    id: "watch",
    label: "Schedule",
    hint: "Cadence and URLs",
    purpose: "When to visit, from where. Off until you turn it on.",
    icon: "clock",
    section: "setup",
  },
  {
    id: "settings",
    label: "This machine",
    hint: "Host report",
    purpose: "What this install can do. Read-only — it reports the files a run already reads.",
    icon: "gear",
    section: "setup",
  },
];

const SECTIONS: { id: NavSectionId; label: string; hint: string }[] = [
  { id: "operate", label: "Operate", hint: "What is happening, and what to fix" },
  { id: "compare", label: "Compare", hint: "The same page from different cities" },
  { id: "setup", label: "Setup", hint: "Cadence and this machine" },
];

export function viewMeta(id: string): NavItemDef | undefined {
  return NAV_ITEMS.find((item) => item.id === id);
}

export function navSections(
  current: ViewId,
  counts: Partial<Record<ViewId, number>>,
  alerts: Partial<Record<ViewId, boolean>>,
): NavSection[] {
  return SECTIONS.map((section) => ({
    ...section,
    links: NAV_ITEMS.filter((item) => item.section === section.id).map((item) => {
      const count = counts[item.id] ?? 0;
      return {
        id: item.id,
        href: `#/${item.id}`,
        label: item.label,
        hint: item.hint,
        icon: item.icon,
        current: item.id === current,
        ...(count > 0 ? { count } : {}),
        ...(alerts[item.id] === true ? { alert: true } : {}),
      };
    }),
  }));
}
