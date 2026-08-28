# @geoqa/mcp

stdio MCP server so agents (Cursor, Claude Desktop, etc.) can read geoqa runs, evidence, and catalog data without parsing CLI output.

## Tools

| Tool | What it returns |
|------|-----------------|
| `profiles_list` | Geographic profiles (market × device) |
| `journeys_list` | Visitor journey definitions |
| `tenants_list` | Tenant registry summary |
| `runs_list` | Run index with filters, summary, regressions |
| `runs_rebuild` | Rebuild `runs.jsonl` from disk |
| `dashboard_get` | Operator dashboard JSON |
| `site_analyse` | Cross-market site analysis |
| `evidence_manifest` | Artifact manifest for one run |
| `evidence_get` | Full package: steps, issues, console, brief |
| `evidence_screenshot` | Screenshot as base64 |

When `GEOQA_SERVER_URL` is set (and optionally `GEOQA_API_TOKEN`):

| Tool | What it returns |
|------|-----------------|
| `server_health` | `/health` from `geoqa server` |
| `server_settings` | `/api/settings` |
| `server_watch_status` | `/api/watch` |

## Resources

- `geoqa://dashboard` — dashboard view (rebuilt on read)
- `geoqa://runs/recent` — last 20 runs
- `geoqa://runs/{runId}` — full evidence package

## Environment

| Variable | Purpose |
|----------|---------|
| `GEOQA_REPO_ROOT` | Git root (auto-detected if omitted) |
| `GEOQA_EVIDENCE_ROOT` | Override evidence directory |
| `GEOQA_TENANT` | Scope to one tenant |
| `GEOQA_SERVER_URL` | e.g. `http://127.0.0.1:4180` for live server proxy |
| `GEOQA_API_TOKEN` | Bearer token (`GEOQA_API_TOKEN` from `geoqa server hash`) |
| `GEOQA_MCP_VERBOSE=1` | Log tool activity to stderr |

## Cursor

Copy `.cursor/mcp.json.example` to `.cursor/mcp.json` and adjust `GEOQA_REPO_ROOT`.

```bash
pnpm mcp   # smoke-test: server starts on stdio (Ctrl+C to exit)
pnpm test:mcp
```

All tool responses include `schemaVersion` from the engine wire contract.
