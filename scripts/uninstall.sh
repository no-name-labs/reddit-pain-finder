#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"

echo "==> Removing Reddit Pain Finder..."

rm -rf "${OPENCLAW_HOME}/workspace/workspace-reddit-pain-finder"
rm -rf "${OPENCLAW_HOME}/agents/reddit-pain-finder"

echo "==> Removed workspace and agent directories."
echo ""
echo "    You should also remove the agent entry, binding, and Telegram account"
echo "    for 'reddit-pain-finder' from ${OPENCLAW_HOME}/openclaw.json"
echo ""
echo "    Then restart OpenClaw: openclaw gateway restart"
