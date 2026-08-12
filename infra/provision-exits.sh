#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Provision one small VM per market, each running a forward HTTP proxy, so geoqa
# has a country-correct exit IP for every market it claims to test.
#
# Azure, and one provider for all of them, because it is the only major cloud
# with BOTH Norway East (a real Oslo region) and Denmark East. A cheaper mix is
# possible — Hetzner is about a third the price for Germany — but five markets on
# one CLI and one bill is worth more than the saving at this scale.
#
# READ infra/README.md FIRST. In particular: you may not need Norway at all if
# you are running this from a Norwegian connection, which is both free and more
# realistic than anything you can buy.
#
# This script CREATES BILLABLE RESOURCES. It therefore does nothing without
# --apply, and prints exactly what it would create instead. A provisioning script
# whose default is to spend money is a provisioning script that spends money by
# accident.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

GROUP="${GEOQA_RG:-geoqa-exits}"
PORT="${GEOQA_PROXY_PORT:-8888}"
ADMIN="${GEOQA_ADMIN_USER:-geoqa}"
IMAGE="${GEOQA_IMAGE:-Ubuntu2404}"

# market:region:size
#
# The size is PER MARKET because SKU availability is per region AND per
# subscription, and the two are not correlated in any way you can predict.
# Measured against subscription 6beb3f50 on 2026-08-12:
#
#   swedencentral        B2ts_v2 / B2als_v2 / D2s_v5 available; B1* NOT
#   denmarkeast          B1ls and most of the B family available
#   norwayeast           NO small SKU available at all — 72 unrestricted SKUs,
#                        every one of them E104/FX-class
#   germanywestcentral   same, none
#   uksouth              same, none
#
# So Azure covers SE and DK. Norway comes free from a Norwegian connection (see
# README), and DE and GB come from any cheap VPS — the cloud-init in this
# directory is plain Ubuntu and runs anywhere. Chasing an Azure quota increase for
# three regions is more work than a €4 Hetzner box.
MARKETS="${GEOQA_MARKETS:-se:swedencentral:Standard_B2ts_v2 dk:denmarkeast:Standard_B1ls}"

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
note() { printf '\033[36m%s\033[0m\n' "$*"; }

command -v az >/dev/null || die "az CLI not found — https://learn.microsoft.com/cli/azure/install-azure-cli"
az account show >/dev/null 2>&1 || die "not logged in — run: az login"

# The firewall is the primary access control, so a source address is mandatory.
# Defaulting it to 0.0.0.0/0 would turn every one of these into an open relay,
# which is abused within hours and costs the IP its reputation.
RUNNER_CIDR="${GEOQA_RUNNER_CIDR:-}"
if [[ -z "$RUNNER_CIDR" ]]; then
  detected="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  [[ -n "$detected" ]] && RUNNER_CIDR="${detected}/32"
fi
[[ -n "$RUNNER_CIDR" ]] || die "set GEOQA_RUNNER_CIDR to the address the runs come FROM (e.g. 203.0.113.7/32)"

PROXY_USER="${GEOQA_PROXY_USER:-geoqa}"
PROXY_PASS="${GEOQA_PROXY_PASS:-}"
if [[ -z "$PROXY_PASS" ]]; then
  # `openssl rand` rather than `tr -dc … </dev/urandom | head -c 32`: that idiom
  # makes `head` close the pipe while `tr` is still writing, so `tr` dies of
  # SIGPIPE and — under `set -o pipefail` — the whole script exits 141 having
  # already generated a perfectly good password. Caught by running this script.
  PROXY_PASS="$(openssl rand -hex 16)"
  [[ -n "$PROXY_PASS" ]] || die "could not generate a password — set GEOQA_PROXY_PASS yourself"
  note "generated a proxy password; printed once at the end and stored nowhere"
fi

CLOUD_INIT_TEMPLATE="$(dirname "$0")/cloud-init-tinyproxy.yaml"
[[ -f "$CLOUD_INIT_TEMPLATE" ]] || die "missing $CLOUD_INIT_TEMPLATE"

echo
note "plan"
printf '  resource group   %s\n' "$GROUP"
printf '  image            %s\n' "$IMAGE"
printf '  proxy port       %s (open ONLY to %s)\n' "$PORT" "$RUNNER_CIDR"
echo

if [[ $APPLY -eq 0 ]]; then
  note "dry run — nothing created. Re-run with --apply to provision."
  for entry in $MARKETS; do
    IFS=: read -r m r z <<<"$entry"
    printf '  would create  %-14s %-20s %s\n' "geoqa-exit-$m" "$r" "$z"
  done
  echo
  note "verify each size is still offered to this subscription:"
  for entry in $MARKETS; do
    IFS=: read -r m r z <<<"$entry"
    printf '  az vm list-skus --location %s --size %s --all -o table\n' "$r" "$z"
  done
  exit 0
fi

az group create --name "$GROUP" --location "$(set -- $MARKETS; IFS=: read -r _ r _ <<<"$1"; echo "$r")" >/dev/null || true

ENV_OUT="$(mktemp)"
for entry in $MARKETS; do
  IFS=: read -r market region SIZE <<<"$entry"
  name="geoqa-exit-${market}"

  # Fail early and per-region: SKU availability genuinely varies by region and
  # subscription, and Denmark East is newer than most. A run that half-provisions
  # is worse than one that refuses.
  if ! az vm list-skus --location "$region" --size "$SIZE" --all --query "[0].name" -o tsv 2>/dev/null | grep -q .; then
    die "$SIZE is not available in $region for this subscription — pick another size or region"
  fi

  note "creating $name in $region"
  init="$(mktemp)"
  sed -e "s|__PROXY_PORT__|${PORT}|g" \
      -e "s|__PROXY_USER__|${PROXY_USER}|g" \
      -e "s|__PROXY_PASS__|${PROXY_PASS}|g" \
      -e "s|__RUNNER_CIDR__|${RUNNER_CIDR}|g" \
      "$CLOUD_INIT_TEMPLATE" > "$init"

  az vm create \
    --resource-group "$GROUP" \
    --name "$name" \
    --location "$region" \
    --image "$IMAGE" \
    --size "$SIZE" \
    --admin-username "$ADMIN" \
    --generate-ssh-keys \
    --public-ip-sku Standard \
    --nsg-rule SSH \
    --custom-data "$init" \
    --only-show-errors >/dev/null

  rm -f "$init"

  # The NSG is the control that matters. tinyproxy binds to every interface on
  # purpose, so this rule is the only thing standing between the port and the
  # internet.
  az network nsg rule create \
    --resource-group "$GROUP" \
    --nsg-name "${name}NSG" \
    --name allow-geoqa-proxy \
    --priority 1000 \
    --source-address-prefixes "$RUNNER_CIDR" \
    --destination-port-ranges "$PORT" \
    --protocol Tcp --access Allow --direction Inbound \
    --only-show-errors >/dev/null

  ip="$(az vm list-ip-addresses --resource-group "$GROUP" --name "$name" \
        --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)"

  printf 'export GEOQA_PROXY_%s="http://%s:%s@%s:%s"\n' \
    "$(printf '%s' "$market" | tr '[:lower:]' '[:upper:]')" \
    "$PROXY_USER" "$PROXY_PASS" "$ip" "$PORT" >> "$ENV_OUT"
done

echo
note "done — export these, then VERIFY before trusting any of it"
echo
cat "$ENV_OUT"
rm -f "$ENV_OUT"
cat <<'VERIFY'

# Confirm each exit geolocates where you think it does. An IP in an Azure
# Norwegian region is not automatically an IP that geolocation databases place in
# Norway, and the whole matrix rests on that being true.
pnpm geoqa proxy verify --geo stockholm-mobile  --provider http-proxy
pnpm geoqa proxy verify --geo copenhagen-mobile --provider http-proxy
pnpm geoqa proxy verify --geo berlin-mobile     --provider http-proxy
pnpm geoqa proxy verify --geo london-mobile     --provider http-proxy

# Then measure it properly: 20 samples, and read the country/city verdicts.
pnpm geoqa experiment run 001 --geo berlin-mobile --provider http-proxy --samples 20

# Tear the whole fleet down when you are finished with it:
#   az group delete --name geoqa-exits --yes
VERIFY
