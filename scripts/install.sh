#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OPENCLAW_HOME="${OPENCLAW_HOME:-}"
TELEGRAM_GROUP_ID=""
TELEGRAM_TOPIC_ID=""
PROXY_URL=""
NON_INTERACTIVE="0"

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [options]

Options:
  --telegram-group-id <group-id>     Telegram group id (e.g. -1003633569118)
  --telegram-topic-id <topic-id>     Telegram topic id (e.g. 1655)
  --proxy <url>                      HTTPS proxy for Reddit (required on cloud servers)
                                     Format: http://user:pass@host:port
  --openclaw-home <path>             Path to .openclaw directory
  --non-interactive                  Skip interactive prompts

The agent uses the existing OpenClaw Telegram bot (account "default").
No separate bot token or Reddit credentials needed — Reddit JSON API is public.
On cloud servers (AWS/GCP/Azure), Reddit blocks requests by IP — use --proxy.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --telegram-group-id) TELEGRAM_GROUP_ID="$2"; shift 2 ;;
    --telegram-topic-id) TELEGRAM_TOPIC_ID="$2"; shift 2 ;;
    --proxy) PROXY_URL="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

prompt_if_empty() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    return
  fi
  if [[ -z "${!var_name:-}" ]]; then
    if [[ -n "${default_value}" ]]; then
      read -r -p "${label} [${default_value}]: " input
      if [[ -z "${input}" ]]; then
        printf -v "${var_name}" '%s' "${default_value}"
      else
        printf -v "${var_name}" '%s' "${input}"
      fi
    else
      read -r -p "${label}: " "${var_name}"
    fi
  fi
}

# --- Resolve OPENCLAW_HOME ---
if [[ -z "${OPENCLAW_HOME}" && -f "${HOME}/.openclaw/openclaw.json" ]]; then
  OPENCLAW_HOME="${HOME}/.openclaw"
fi
if [[ -z "${OPENCLAW_HOME}" ]]; then
  echo "Could not find openclaw.json. Pass --openclaw-home or set OPENCLAW_HOME." >&2
  exit 1
fi
if [[ ! -f "${OPENCLAW_HOME}/openclaw.json" ]]; then
  echo "Missing ${OPENCLAW_HOME}/openclaw.json" >&2
  exit 1
fi

echo "==> Reddit Pain Finder installer"
echo "    OpenClaw home: ${OPENCLAW_HOME}"
echo ""

# --- Collect inputs ---
prompt_if_empty TELEGRAM_GROUP_ID "Telegram group id"
prompt_if_empty TELEGRAM_TOPIC_ID "Telegram topic id"

if [[ -z "${TELEGRAM_GROUP_ID}" || -z "${TELEGRAM_TOPIC_ID}" ]]; then
  echo "Missing required Telegram group/topic id." >&2
  exit 1
fi

# --- Copy workspace ---
WORKSPACE_DIR="${OPENCLAW_HOME}/workspace/workspace-reddit-pain-finder"
AGENT_DIR="${OPENCLAW_HOME}/agents/reddit-pain-finder"

echo "==> Copying workspace files..."
rm -rf "${WORKSPACE_DIR}"
mkdir -p "${WORKSPACE_DIR}" "${AGENT_DIR}/sessions"
cp -R "${ROOT_DIR}/workspace-reddit-pain-finder/"* "${WORKSPACE_DIR}/"

# --- Install Node dependencies ---
echo "==> Installing Node.js dependencies (cheerio only, no browser needed)..."
cd "${WORKSPACE_DIR}/tools/reddit-scraper"
if [[ -f "package.json" ]]; then
  npm install --silent 2>/dev/null
fi
cd "${ROOT_DIR}"

# --- Write minimal config ---
echo "==> Writing scraper config..."
cat > "${WORKSPACE_DIR}/tools/reddit-scraper/config.json" <<CONFIG_EOF
{
  "requestDelayMs": 1200,
  "lookbackHours": 168,
  "maxFeedPages": 15,
  "maxCommentsPerPost": 200,
  "fetchComments": true,
  "outputDir": "../../data/analysis",
  "locale": "en-US",
  "timeoutMs": 90000,
  "verbose": true
}
CONFIG_EOF

# --- Initialize data directory ---
mkdir -p "${WORKSPACE_DIR}/data/analysis"
echo "{}" > "${WORKSPACE_DIR}/data/state.json"

# --- Update telegram-buttons.js with correct chat/topic ---
if [[ -f "${WORKSPACE_DIR}/tools/telegram-buttons.js" ]]; then
  sed -i.bak "s|chatId: '.*'|chatId: '${TELEGRAM_GROUP_ID}'|" "${WORKSPACE_DIR}/tools/telegram-buttons.js" 2>/dev/null || \
  sed -i '' "s|chatId: '.*'|chatId: '${TELEGRAM_GROUP_ID}'|" "${WORKSPACE_DIR}/tools/telegram-buttons.js"
  sed -i.bak "s|topicId: [0-9]*|topicId: ${TELEGRAM_TOPIC_ID}|" "${WORKSPACE_DIR}/tools/telegram-buttons.js" 2>/dev/null || \
  sed -i '' "s|topicId: [0-9]*|topicId: ${TELEGRAM_TOPIC_ID}|" "${WORKSPACE_DIR}/tools/telegram-buttons.js"
  rm -f "${WORKSPACE_DIR}/tools/telegram-buttons.js.bak"
fi

# --- Replace workspace path placeholders ---
if [[ -f "${WORKSPACE_DIR}/IDENTITY.md" ]]; then
  sed -i.bak "s|{{WORKSPACE_PATH}}|${WORKSPACE_DIR}|g" "${WORKSPACE_DIR}/IDENTITY.md" 2>/dev/null || \
  sed -i '' "s|{{WORKSPACE_PATH}}|${WORKSPACE_DIR}|g" "${WORKSPACE_DIR}/IDENTITY.md"
  rm -f "${WORKSPACE_DIR}/IDENTITY.md.bak"
fi

# --- Patch openclaw.json ---
echo "==> Patching openclaw.json..."
CONFIG_PATH="${OPENCLAW_HOME}/openclaw.json" \
WORKSPACE_PATH="${WORKSPACE_DIR}" \
AGENT_DIR_PATH="${AGENT_DIR}" \
GROUP_ID_ENV="${TELEGRAM_GROUP_ID}" \
TOPIC_ID_ENV="${TELEGRAM_TOPIC_ID}" \
python3 - <<'PY'
import json
import os
from pathlib import Path

config_path = Path(os.environ["CONFIG_PATH"])
workspace = os.environ["WORKSPACE_PATH"]
agent_dir = os.environ["AGENT_DIR_PATH"]
group_id = os.environ["GROUP_ID_ENV"]
topic_id = os.environ["TOPIC_ID_ENV"]

data = json.loads(config_path.read_text(encoding="utf-8"))

# Agent entry
agents = data.setdefault("agents", {})
agent_list = agents.setdefault("list", [])
agent_entry = {
    "id": "reddit-pain-finder",
    "name": "Reddit Pain Finder",
    "workspace": workspace,
    "agentDir": agent_dir,
    "heartbeat": {"every": "0m"},
    "identity": {"name": "Reddit Pain Finder"},
}
for idx, item in enumerate(agent_list):
    if item.get("id") == "reddit-pain-finder":
        agent_list[idx] = agent_entry
        break
else:
    agent_list.append(agent_entry)

# Binding — uses existing "default" Telegram account
peer_id = f"{group_id}:topic:{topic_id}"
bindings = data.setdefault("bindings", [])
binding_entry = {
    "agentId": "reddit-pain-finder",
    "match": {
        "channel": "telegram",
        "accountId": "default",
        "peer": {
            "kind": "group",
            "id": peer_id,
        },
    },
}
for idx, item in enumerate(bindings):
    if item.get("agentId") == "reddit-pain-finder":
        bindings[idx] = binding_entry
        break
else:
    bindings.append(binding_entry)

config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

# --- Configure proxy if provided ---
if [[ -n "${PROXY_URL}" ]]; then
  echo "==> Configuring proxy: ${PROXY_URL}"
  ENV_FILE="${OPENCLAW_HOME}/reddit-pain-finder.env"
  echo "HTTPS_PROXY=${PROXY_URL}" > "${ENV_FILE}"
  echo "HTTP_PROXY=${PROXY_URL}" >> "${ENV_FILE}"

  # Try to add to systemd drop-in if gateway runs under systemd
  UNIT_DIR="${HOME}/.config/systemd/user"
  if [[ -d "${UNIT_DIR}" ]]; then
    shopt -s nullglob
    for unit in "${UNIT_DIR}"/openclaw-gateway*.service; do
      DROPIN_DIR="${UNIT_DIR}/$(basename "${unit}").d"
      mkdir -p "${DROPIN_DIR}"
      cat > "${DROPIN_DIR}/reddit-proxy.conf" <<SYSD_EOF
[Service]
EnvironmentFile=${ENV_FILE}
SYSD_EOF
    done
    shopt -u nullglob
    systemctl --user daemon-reload 2>/dev/null || true
  fi

  echo "    Proxy env saved to ${ENV_FILE}"
  echo "    If gateway is not under systemd, add to your startup:"
  echo "      export HTTPS_PROXY=\"${PROXY_URL}\""
fi

# --- Restart gateway ---
echo "==> Restarting OpenClaw gateway..."
if command -v openclaw >/dev/null 2>&1; then
  openclaw gateway restart 2>/dev/null || true
else
  echo "    openclaw CLI not found. Restart the gateway manually." >&2
fi

echo ""
echo "==> Reddit Pain Finder installed successfully!"
echo "    Workspace: ${WORKSPACE_DIR}"
if [[ -n "${PROXY_URL}" ]]; then
  echo "    Proxy: ${PROXY_URL}"
fi
echo "    Send /reset in your Telegram topic to start."
