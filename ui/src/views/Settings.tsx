/**
 * Settings: what this installation is configured to do, and what it is missing to do it.
 *
 * **No credential value appears here, because none is ever sent.** `/api/settings` reports
 * whether a named environment variable is SET — a boolean derived from `name in env`, with
 * the value never read (R-26). Even a masked value would be wrong: masking is a display
 * decision applied to something that already travelled, and the safest thing to send a
 * browser is a fact about presence. "Is `GEOQA_PROXY_OSLO` configured on this host?" is the
 * question an operator actually has, and it is answerable without the secret.
 *
 * This is a read-only screen on purpose. Everything it shows is derived from the files the
 * engine itself reads, so the page cannot drift from what a run would actually use — and a
 * settings screen showing a different truth from the runtime is worse than no settings
 * screen. Editing here would make this page a second author of those files, and anything the
 * two disagreed about would be decided by whichever wrote last.
 */
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { getJson } from "../api.ts";

interface CredentialStatus {
  name: string;
  present: boolean;
  purpose: string;
}

interface SettingsData {
  tenants: {
    id: string;
    name: string;
    markets: string[];
    targets: string[];
    quota: { trafficMb: number; runsPerDay: number };
    retentionDays: number;
    credentials: CredentialStatus[];
    meterable: boolean;
  }[];
  markets: string[];
  journeys: { id: string; title: string; writes: boolean; requiredVars: string[] }[];
  config: {
    source: string;
    provider: string;
    verifyEndpoint: string;
    evidenceRoot: string;
    cooldownMs: number;
    retention: Record<string, string[]>;
  };
  credentials: CredentialStatus[];
  server: { authenticated: true; sessionHours: number };
}

export function Settings(): JSX.Element {
  const [data, setData] = useState<SettingsData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void getJson<SettingsData>("/api/settings").then((result) => {
      if (result.ok) setData(result.value);
      else setProblem(result.signedOut ? "this console is not signed in" : result.error);
    });
  }, []);

  if (problem !== null) {
    return (
      <>
        <div className="head">
          <h2>Settings</h2>
          <p className="hint">
            This page reads live configuration from the server, so it is unavailable in a static build — which is a
            legitimate way to read the rest of this console, since evidence is files a browser can open. Run{" "}
            <code>geoqa server</code> to see it.
          </p>
        </div>
        <div className="empty">
          <strong>No configuration to show.</strong>
          {problem}
        </div>
      </>
    );
  }
  if (data === null) return <div className="load">reading configuration…</div>;

  return (
    <>
      <div className="head">
        <h2>Settings</h2>
        <p className="hint">
          Read from the files the engine itself uses, so this page cannot disagree with what a run would actually do.
          Credentials show as <b>set</b> or <b>not set</b> — no value is ever sent to this browser.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Tenants</h3>
          <p className="hint">Each one&rsquo;s markets, the domains it is allowed to measure, and its ceilings.</p>
        </div>
        {data.tenants.length === 0 ? (
          <div className="empty">
            <strong>No tenant files on disk.</strong>
            Add one under <code>tenants/</code>.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Markets</th>
                  <th>Domains</th>
                  <th className="center">Traffic</th>
                  <th className="center">Runs/day</th>
                  <th className="center">Retention</th>
                  <th>Attribution</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.name}
                      <div className="dim mono">{t.id}</div>
                    </td>
                    <td className="mono">{t.markets.join(", ") || "—"}</td>
                    <td className="mono">{t.targets.join(", ") || "—"}</td>
                    <td className="center num">{t.quota.trafficMb} MB</td>
                    <td className="center num">{t.quota.runsPerDay}</td>
                    <td className="center num">{t.retentionDays}d</td>
                    <td>
                      {t.meterable ? (
                        <span className="pill good">metered</span>
                      ) : (
                        // Not "unlimited". The vendor reports ONE figure for every tenant on a
                        // shared account, so attributing it to one of them would be a
                        // fabrication. Unmeasurable and unlimited are different facts.
                        <span className="pill unknown" title="shares the default proxy account">
                          unmeasurable
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Credentials</h3>
          <p className="hint">
            Variable names, and whether this host has them. The values are never read by the server and never sent here.
          </p>
        </div>
        <Credentials rows={[...data.credentials, ...data.tenants.flatMap((t) => t.credentials)]} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Journeys</h3>
          <p className="hint">What a run may be asked to do, and what it must be given to do it.</p>
        </div>
        {data.journeys.length === 0 ? (
          <div className="empty">
            <strong>No journeys on disk.</strong>
            Add one under <code>journeys/</code>.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Journey</th>
                  <th>Title</th>
                  <th className="center">Effect</th>
                  <th>Requires</th>
                </tr>
              </thead>
              <tbody>
                {data.journeys.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{j.id}</td>
                    <td>{j.title}</td>
                    <td className="center">
                      {/* A journey that submits a form is the one thing a sweep must not do by
                          accident, so it is marked rather than left as a field to notice. */}
                      {j.writes ? <span className="pill warn">writes</span> : <span className="dim">read-only</span>}
                    </td>
                    <td className="mono">{j.requiredVars.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Engine</h3>
          <p className="hint">
            Which configuration file is in force, said out loud — a run on built-in defaults because the file sits one
            directory up otherwise looks identical to one that honoured it.
          </p>
        </div>
        <div className="scroll">
          <table>
            <tbody>
              <Row k="Config source" v={data.config.source} />
              <Row k="Network provider" v={data.config.provider} />
              <Row k="Verify endpoint" v={data.config.verifyEndpoint} />
              <Row k="Evidence root" v={data.config.evidenceRoot} />
              <Row k="Vendor cooldown" v={`${data.config.cooldownMs} ms`} />
              <Row k="Markets with a profile" v={data.markets.join(", ") || "—"} />
              <Row k="Session length" v={`${data.server.sessionHours} hours`} />
              {Object.entries(data.config.retention).map(([tier, kinds]) => (
                <Row key={tier} k={`Retention · ${tier}`} v={kinds.join(", ") || "nothing kept"} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Credentials({ rows }: { rows: CredentialStatus[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <strong>No credential variables named.</strong>
        Tenants name theirs in their own file.
      </div>
    );
  }
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th className="center">State</th>
            <th>What it is for</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={`${c.name}-${c.purpose}`}>
              <td className="mono">{c.name}</td>
              <td className="center">
                {c.present ? <span className="pill good">set</span> : <span className="pill unknown">not set</span>}
              </td>
              <td>{c.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }): JSX.Element => (
  <tr>
    <td className="col-label">{k}</td>
    <td className="mono">{v}</td>
  </tr>
);
