# geoqa UI

A read-only run browser. **Static, and that is the design.**

`geoqa dashboard build` writes `dashboard.json` next to the evidence it describes; this app
fetches that one file and renders it. No server, no port, no auth surface, nothing to keep
running — the whole thing is a directory you can open, host behind a CDN, or serve from the
evidence root.

## Why React and not Electron

The criterion recorded in the loop's task list was: *does it need filesystem access beyond a
served directory?* It does not. Evidence is files under a root — screenshots, traces,
`run.json` — and a browser reads them over HTTP like any other asset. Electron would buy
filesystem access nothing needs, and cost a 100 MB runtime, a signing story and a release
channel.

## Why every judgement lives in `src/`, not here

The view model comes from `packages/engine/src/report/view.ts`, which is covered at 100% like the rest of the
engine. This app is a renderer.

That split exists for one specific reason. The engine refuses everywhere to conflate "we
could not look" with "it is fine" — and a dashboard is exactly where a number gets believed.
So a UI cannot be trusted to remember that a null LCP is not `0`; instead every displayed
value arrives as a `Measured<T>`:

```ts
{ measured: true,  value: 421, text: "421ms" }
{ measured: false, reason: "no largest-contentful-paint entry was emitted", text: "not measured" }
```

A renderer writing `{v.text}` gets "not measured" rather than "0", because an absence is a
different TYPE from a reading. Styling them differently is then a choice about emphasis
rather than the only thing standing between a reader and a wrong conclusion.

## Running it

```bash
pnpm geoqa dashboard build            # writes <evidence-root>/dashboard.json
pnpm --filter geoqa-ui dev            # or: serve the built app from the evidence root
```

`pnpm ui:build` emits static files into `apps/ui/dist`. Copy them beside `dashboard.json` and the
app finds it at `./dashboard.json`.
