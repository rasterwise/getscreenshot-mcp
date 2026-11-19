#!/usr/bin/env bash
#
# Deploys the hosted MCP server to Cloud Run.
#
#   GCP_PROJECT=my-project ./deploy.sh          # prints what it would run, deploys nothing
#   GCP_PROJECT=my-project ./deploy.sh --yes    # deploys
#
# Required environment:
#   GCP_PROJECT             Google Cloud project id to deploy into.
#
# Optional environment:
#   REGION                  Cloud Run region (default us-central1)
#   SERVICE                 Cloud Run service name (default getscreenshot-mcp)
#   PUBLIC_BASE_URL         Public origin of the MCP endpoint
#                           (default https://mcp.getscreenshotapi.com)
#   HTML_PUBLIC_BASE_URL    Public origin for render_html documents (/h/<id>).
#                           Point it at a throwaway domain mapped to the same
#                           service, so a hosted page that gets flagged cannot
#                           damage the MCP hostname. Defaults to PUBLIC_BASE_URL.
#   TRIAL_API_KEY_SECRET    Name of a Secret Manager secret holding an API key.
#                           Setting it turns on keyless preview mode. Its
#                           counters are in memory and reset on every restart
#                           and scale-to-zero, so do not use it in production
#                           yet. Leave it unset to keep preview mode off.
#   TRIAL_DAILY_LIMIT_PER_IP, TRIAL_DAILY_LIMIT_GLOBAL
#                           Preview limits (defaults 5 and 200); only used with
#                           TRIAL_API_KEY_SECRET.
#
# The deploy is declarative for environment variables and secrets:
#   --set-env-vars replaces all environment variables of the service.
#   --set-secrets replaces all secrets; --clear-secrets removes them all.
# So leaving TRIAL_API_KEY_SECRET unset removes a TRIAL_API_KEY that an earlier
# deploy attached, whether it was a secret or a plain variable, and preview
# mode is off afterwards.
#
# --max-instances 1 is required: render_html documents, the rate limiters and
# the image gate live in the memory of one instance.
set -euo pipefail

if [[ -z "${GCP_PROJECT:-}" ]]; then
  echo "GCP_PROJECT is not set. Set it to the Google Cloud project id to deploy into:" >&2
  echo "  GCP_PROJECT=my-project ./deploy.sh" >&2
  exit 2
fi

PROJECT="${GCP_PROJECT}"
SERVICE="${SERVICE:-getscreenshot-mcp}"
REGION="${REGION:-us-central1}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://mcp.getscreenshotapi.com}"

cd "$(dirname "$0")"

ENV_VARS="PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
if [[ -n "${HTML_PUBLIC_BASE_URL:-}" ]]; then
  ENV_VARS+=",HTML_PUBLIC_BASE_URL=${HTML_PUBLIC_BASE_URL}"
fi

if [[ -n "${TRIAL_API_KEY_SECRET:-}" ]]; then
  ENV_VARS+=",TRIAL_DAILY_LIMIT_PER_IP=${TRIAL_DAILY_LIMIT_PER_IP:-5},TRIAL_DAILY_LIMIT_GLOBAL=${TRIAL_DAILY_LIMIT_GLOBAL:-200}"
  SECRET_ARGS=(--set-secrets "TRIAL_API_KEY=${TRIAL_API_KEY_SECRET}:latest")
  PREVIEW="ON, key from secret ${TRIAL_API_KEY_SECRET} (in-memory counters: not for production)"
else
  SECRET_ARGS=(--clear-secrets)
  PREVIEW="off (any TRIAL_API_KEY attached by an earlier deploy is removed)"
fi

CMD=(
  gcloud run deploy "${SERVICE}"
  --project "${PROJECT}"
  --region "${REGION}"
  --source .
  --allow-unauthenticated
  --max-instances 1
  --min-instances 0
  --concurrency 40
  --cpu 1
  --memory 2Gi
  --timeout 300
  --set-env-vars "${ENV_VARS}"
  "${SECRET_ARGS[@]}"
)

if [[ "${1:-}" != "--yes" ]]; then
  echo "This would deploy to Cloud Run:" >&2
  echo "  project:   ${PROJECT}" >&2
  echo "  service:   ${SERVICE}" >&2
  echo "  region:    ${REGION}" >&2
  echo "  MCP URL:   ${PUBLIC_BASE_URL}/mcp" >&2
  echo "  HTML host: ${HTML_PUBLIC_BASE_URL:-${PUBLIC_BASE_URL} (same as the MCP host)}" >&2
  echo "  preview:   ${PREVIEW}" >&2
  echo "  env vars:  replaced with ${ENV_VARS}" >&2
  echo >&2
  printf '  ' >&2
  printf '%q ' "${CMD[@]}" >&2
  echo >&2
  echo >&2
  echo "Nothing was deployed. Re-run with --yes to deploy." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH." >&2
  exit 1
fi

echo "Deploying ${SERVICE} to ${PROJECT} (${REGION}); preview mode: ${PREVIEW}" >&2
"${CMD[@]}"

echo >&2
echo "Deployed. Check it:" >&2
echo "  curl -s ${PUBLIC_BASE_URL}/healthz" >&2
echo "If a hostname is not mapped to the service yet, map it first:" >&2
echo "  gcloud beta run domain-mappings create --service ${SERVICE} --domain ${PUBLIC_BASE_URL#https://} --project ${PROJECT} --region ${REGION}" >&2
