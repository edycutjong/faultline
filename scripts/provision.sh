#!/usr/bin/env bash
#
# Provision the Nebius resources Faultline needs, and print the environment variables to set.
#
# Idempotent: re-running reuses anything that already exists. Prints a .env block at the end;
# it never writes secrets to disk itself.
#
# Prerequisites: the Nebius CLI, authenticated, against a tenant that is NOT suspended.
# Check first:
#     nebius iam tenant list --format json | grep suspension_state
# A SUSPENDED tenant returns an empty project list and PermissionDenied on every create, so
# this script will fail confusingly rather than usefully.

set -euo pipefail

SA_NAME="${FAULTLINE_SA_NAME:-faultline}"
BUCKET="${FAULTLINE_BUCKET:-faultline}"
KEY_DIR="${FAULTLINE_KEY_DIR:-$HOME/.config/faultline}"

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have nebius || die "the nebius CLI is not on PATH"
have openssl || die "openssl is required to generate the authorized key"
have jq || die "jq is required to read CLI output"

echo "==> checking the tenant is usable"
suspension=$(nebius iam tenant list --format json | jq -r '.items[0].status.suspension_state // "UNKNOWN"')
if [ "$suspension" != "ACTIVE" ] && [ "$suspension" != "UNSPECIFIED" ]; then
  die "tenant suspension_state is ${suspension}. Nothing can be created until that clears."
fi

PROJECT_ID="${NEBIUS_PROJECT_ID:-$(nebius iam project list --format json | jq -r '.items[0].metadata.id // empty')}"
[ -n "$PROJECT_ID" ] || die "no project found; set NEBIUS_PROJECT_ID"
echo "    project: $PROJECT_ID"

echo "==> service account"
SA_ID=$(nebius iam service-account get-by-name --name "$SA_NAME" --parent-id "$PROJECT_ID" --format json 2>/dev/null | jq -r '.metadata.id // empty' || true)
if [ -z "$SA_ID" ]; then
  SA_ID=$(nebius iam service-account create --name "$SA_NAME" --parent-id "$PROJECT_ID" --format json | jq -r '.metadata.id')
  echo "    created $SA_ID"
else
  echo "    reusing $SA_ID"
fi

echo "==> authorized key (signs the JWT exchanged for a Bearer token)"
mkdir -p "$KEY_DIR"; chmod 700 "$KEY_DIR"
PRIVATE_PEM="$KEY_DIR/faultline-private.pem"
if [ ! -f "$PRIVATE_PEM" ]; then
  openssl genrsa -out "$PRIVATE_PEM" 4096 2>/dev/null
  chmod 600 "$PRIVATE_PEM"
  openssl rsa -in "$PRIVATE_PEM" -outform PEM -pubout -out "$KEY_DIR/faultline-public.pem" 2>/dev/null
  echo "    generated $PRIVATE_PEM"
fi
AUTH_KEY_ID=$(nebius iam auth-public-key create \
  --account-service-account-id "$SA_ID" \
  --data "$(cat "$KEY_DIR/faultline-public.pem")" \
  --format json | jq -r '.metadata.id')
echo "    authorized key: $AUTH_KEY_ID"

echo "==> access key (a SEPARATE credential, for the S3 API)"
ACCESS_KEY_ID=$(nebius iam v2 access-key create --account-service-account-id "$SA_ID" --description "faultline object storage" --format json | jq -r '.metadata.id')
AWS_KEY=$(nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.aws_access_key_id')
AWS_SECRET=$(nebius iam v2 access-key get --id "$ACCESS_KEY_ID" --format json | jq -r '.status.secret')

echo "==> bucket"
if ! nebius storage bucket get-by-name --name "$BUCKET" --parent-id "$PROJECT_ID" >/dev/null 2>&1; then
  nebius storage bucket create --name "$BUCKET" --parent-id "$PROJECT_ID" >/dev/null
  echo "    created $BUCKET"
else
  echo "    reusing $BUCKET"
fi

SUBNET_ID=$(nebius vpc subnet list --parent-id "$PROJECT_ID" --format json | jq -r '.items[0].metadata.id // empty')

cat <<OUT

Provisioned. Set these (locally in .env, or as Vercel project env vars):

NEBIUS_SERVICE_ACCOUNT_ID=$SA_ID
NEBIUS_AUTH_KEY_ID=$AUTH_KEY_ID
NEBIUS_AUTH_PRIVATE_KEY="$(awk 'NF {sub(/\r/,""); printf "%s\\n", $0;}' "$PRIVATE_PEM")"
NEBIUS_PROJECT_ID=$PROJECT_ID
NEBIUS_SUBNET_ID=$SUBNET_ID
NEBIUS_BUCKET=$BUCKET
NEBIUS_S3_ACCESS_KEY_ID=$AWS_KEY
NEBIUS_S3_SECRET_ACCESS_KEY=$AWS_SECRET

The private key stays in $KEY_DIR and is never written into the repository.
Grant the service account the 'editors' group so it can create jobs and write the bucket.
OUT
