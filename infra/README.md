# Exit IPs

geoqa needs one country-correct egress per market. This directory provisions the
smallest thing that provides one.

## Start by not buying Norway

**Your own office connection is a real Norwegian ISP address.** For the home
market that is not a compromise, it is the most realistic egress available — an
actual consumer/business ISP IP of the kind a real visitor has, not a cloud range
that geolocation databases label as hosting. It is also free and already wired:
`--provider direct` is the default, and needs no configuration at all.

```bash
pnpm geoqa journey run --geo oslo-mobile --journey reader --url https://digilist.no/blogg
```

Two things this does NOT mean, and both matter:

**It does not make EXP-001 measurable.** That experiment asks whether the routing
mechanism can reach a requested market on demand. Run from a Norwegian office it
observes `NO` because of where the machine sits, so it reports `unmeasured` with a
reason rather than a green tick — see `NO_VENDOR_NOTE` in `cli/samplers.ts`. A
*journey* for a Norwegian profile on direct egress is a different question and is
fully valid: you genuinely are a Norwegian visitor.

**It does not extend to the other four markets.** A Norwegian ISP allocates
Norwegian registry space. There is no product in which your ISP hands you a German
address; for that you need something that is physically in Germany. Hence the four
VMs below rather than five.

## The one thing to check before trusting it

Your office address may be **privileged inside your own stack** — allowlisted in
Cloudflare, exempt from a rate limit, on a WAF bypass, or whitelisted by a
colleague years ago. If it is, direct-egress runs exercise a path no visitor has,
and every result about blocking, challenges and throttling is wrong in the
flattering direction.

Check it, and if it turns out to be privileged, provision Norway too — that is a
reason to spend the extra €7 a month, not a reason to ignore the problem.

A second constraint arrives with automation: **CI runners are in datacentres, not
your office.** Scheduling nightly runs on GitHub Actions silently loses the
Norwegian egress. Either use a self-hosted runner on the office connection, or add
`no:norwayeast` to the market list.

## The unpurchasable markets

Bergen, Trondheim and Gothenburg city-level exits are not sold, at any price, by
any vendor — there is too little exit infrastructure there. If anyone on the team
works from Bergen or Trondheim, a small always-on box on their home connection
(a Pi, an old laptop) running the same tinyproxy config is the **only** way to turn
`city: unverified` into `city: match` for those markets. Reach it over a WireGuard
or Tailscale link rather than by opening a port on someone's home router.

Without that, those markets stay differentiated on the browser axis — locale,
clock, viewport, coordinates — while the network axis reports country-level. geoqa
says which is which rather than claiming a city it cannot prove.

## Provisioning the rest

```bash
# Dry run. Prints the plan and the SKU-availability checks; creates nothing.
./infra/provision-exits.sh

# When the plan looks right:
export GEOQA_RUNNER_CIDR="203.0.113.7/32"   # where the RUNS come from
./infra/provision-exits.sh --apply
```

Azure for all of them, because it is the only major cloud with both **Norway East**
(a real Oslo region) and **Denmark East**. Hetzner is roughly a third the price for
Germany and the UK if you would rather split providers; the script takes a market
list, so `GEOQA_MARKETS="se:swedencentral dk:denmarkeast"` provisions a subset.

Roughly **$7/month per exit** — `Standard_B1ls` plus a standard IPv4 address. Four
markets is about $28/month, flat, with no per-GB metering.

`Standard_B1ls` availability genuinely varies by region and subscription, and
Denmark East is newer than the rest. The script checks each region before creating
anything and refuses rather than half-provisioning.

## Then verify, do not assume

An IP in an Azure Norwegian region is not automatically an IP that geolocation
databases *place* in Norway, and the entire matrix rests on that being true.

```bash
pnpm geoqa proxy verify --geo stockholm-mobile --provider http-proxy
pnpm geoqa experiment run 001 --geo berlin-mobile --provider http-proxy --samples 20
```

Read the per-axis verdicts and record which markets come back `match` versus
`unverified`. That is your real coverage map, measured rather than promised.

## Teardown

```bash
az group delete --name geoqa-exits --yes
```

## Why tinyproxy and not squid

Squid is a caching proxy, and a cache is the last thing a QA exit should have: a
cached response makes geoqa measure what the proxy remembered rather than what the
site served, and does it silently. tinyproxy forwards and forgets.

The setting that matters most is `DisableViaHeader`. By default tinyproxy appends
`Via: 1.1 tinyproxy` to plain-HTTP requests, announcing to your own CDN that the
request is proxied — and a CDN that treats proxied traffic differently changes the
very thing being measured. For `https://` targets the browser issues `CONNECT` and
the proxy tunnels bytes it cannot read, so no header can be added at all; the Via
header only ever touched plain HTTP, which still matters because an
`http:// → https://` redirect is exactly the kind of geo behaviour a journey tests.

## Security posture

The **firewall is the primary control**, not the proxy password. tinyproxy binds
to every interface deliberately, so the Azure NSG rule and `ufw` are the only
things between the port and the internet — an open forward proxy becomes someone
else's relay within hours and takes the address's reputation with it, which for
this use case is the asset you were paying for.

Basic auth is defence in depth only. The proxy connection is unencrypted, so those
credentials cross the network in the clear; that is tolerable only because the
source address is already restricted. If you want the hop encrypted, use
WireGuard on the same box and point the context at it as a proxy endpoint — not as
a host tunnel. See the egress decision note for why that distinction matters.
