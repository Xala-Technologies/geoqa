/**
 * The findings page is the same grouping as the GitHub tickets.
 *
 * A check that failed on three hosts is three rows, because that is three
 * issues and three PRs. Collapsing them into one "has a search box" line
 * is how a reader would miss that xala.no is a different repo from
 * digilist.no.
 *
 * Issue and PR arrive as Measured: not filed is an absence, not a blank
 * cell that looks like we forgot to look.
 */
import type { TicketDraft } from "../findings/tickets.js";
import { measured, unmeasured, type Measured } from "./measured.js";

export interface FindingTicket {
  key: string;
  title: string;
  site: string;
  hosts: string[];
  urgent: boolean;
  runIds: string[];
  issue: Measured<{ number: number; url: string }>;
  pr: Measured<{ url: string }>;
}

export interface FiledRef {
  key: string;
  number: number;
  url: string;
}

export interface RepairRef {
  key: string;
  status: string;
  prUrl?: string;
}

export function ticketsForView(drafts: TicketDraft[], filed: readonly FiledRef[], repaired: readonly RepairRef[]): FindingTicket[] {
  const issues = new Map(filed.map((item) => [item.key, item]));
  const repairs = new Map(repaired.map((item) => [item.key, item]));
  return drafts.map((draft) => {
    const issue = issues.get(draft.key);
    const repair = repairs.get(draft.key);
    return {
      key: draft.key,
      title: draft.title,
      site: draft.site,
      hosts: draft.hosts,
      urgent: draft.urgent,
      runIds: draft.runIds,
      issue:
        issue === undefined
          ? unmeasured("not filed on GitHub")
          : measured({ number: issue.number, url: issue.url }, `#${issue.number}`),
      pr: prOf(repair),
    };
  });
}

function prOf(repair: RepairRef | undefined): Measured<{ url: string }> {
  if (repair?.prUrl !== undefined && repair.prUrl !== "") {
    return measured({ url: repair.prUrl }, repair.prUrl);
  }
  if (repair?.status === "cannot-fix") return unmeasured("Claude could not fix this in the repo");
  if (repair?.status === "no-changes") return unmeasured("no code change was committed");
  return unmeasured("no pull request yet");
}
