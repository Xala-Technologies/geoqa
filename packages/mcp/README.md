# @geoqa/mcp

stdio MCP server — agents read and drive geoqa over Model Context Protocol.

## Setup

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
# set GEOQA_REPO_ROOT, GEOQA_SERVER_URL, GEOQA_API_TOKEN
pnpm mcp   # smoke-test (Ctrl+C)
```

Generate credentials:

```bash
pnpm geoqa server hash '<your-password>'
# exports GEOQA_ADMIN_PASSWORD_HASH, GEOQA_SESSION_SECRET, GEOQA_API_TOKEN
```

Set the same `GEOQA_API_TOKEN` on the VPS in `/opt/geoqa/.env`, then `systemctl restart geoqa`.

## Local tools (evidence on disk)

| Tool | CLI equivalent |
|------|----------------|
| `profiles_list` | `geoqa profile list` |
| `journeys_list` | `geoqa journey list` |
| `tenants_list` | `geoqa tenant list` |
| `settings_get` | `GET /api/settings` |
| `runs_list` | `geoqa runs list` |
| `runs_rebuild` | `geoqa runs rebuild` |
| `dashboard_get` | `geoqa dashboard build` |
| `site_analyse` | site analysis |
| `content_analyse` | content analysis |
| `evidence_manifest` | `geoqa evidence inspect` |
| `evidence_get` | evidence package |
| `evidence_screenshot` | screenshot base64 |
| `evidence_prune` | `geoqa evidence prune` |
| `assist_explain` | `geoqa assist explain` |
| `digest_send` | `geoqa digest send` |
| `findings_file` | `geoqa findings file` |
| `findings_repair` | `geoqa findings repair` |
| `fix_run` | `geoqa fix run` |
| `keywords_research` | `geoqa keywords research` |
| `browser_verify` | `geoqa browser verify` |
| `proxy_verify` | `geoqa proxy verify` |
| `journey_run` | `geoqa journey run` |
| `gate_check` | `geoqa gate check` |
| `matrix_run` | `geoqa matrix run` |
| `experiment_run` | `geoqa experiment run` |

## Remote tools (`GEOQA_SERVER_URL` + `GEOQA_API_TOKEN`)

| Tool | HTTP |
|------|------|
| `server_health` | `GET /health` |
| `server_whoami` | `GET /api/whoami` |
| `server_settings` | `GET /api/settings` |
| `server_dashboard_rebuild` | `POST /api/dashboard/rebuild` |
| `server_watch_get` | `GET /api/watch` |
| `server_watch_update` | `PUT /api/watch` |
| `server_watch_log` | `GET /api/watch/log` |
| `server_watch_start` | `POST /api/watch/start` |
| `server_watch_target_add` | `POST /api/watch/targets` |
| `server_watch_target_remove` | `DELETE /api/watch/targets` |
| `server_live_board` | `GET /api/live` |
| `server_live_session` | `GET /api/live/:id` |
| `server_live_frame` | `GET /api/live/:id/frame` |
| `server_run_status` | `GET /api/run` |
| `server_run_start` | `POST /api/run` |
| `server_findings_repair_status` | `GET /api/findings/repair` |
| `server_findings_repair_start` | `POST /api/findings/repair` |
| `server_evidence_get` | `GET /api/evidence/:runId` |
| `server_evidence_screenshot` | `GET /api/evidence/:runId/shot/:label` |

## Resources

- `geoqa://dashboard`
- `geoqa://runs/recent`
- `geoqa://runs/{runId}`

Execution tools launch real browsers and spend proxy traffic — MCP marks them with `destructiveHint`.
