#!/bin/bash
# Runs ZEN on an Anthropic-compatible gateway (e.g. the org's Kimi). Credentials live in .kimi.env (git-ignored).
#   ./start-kimi.sh                 Kimi for everything
#   FAST=<model> ./start-kimi.sh    Kimi + a fast model for face commands and small talk
cd "$(dirname "$0")"
[ -f .kimi.env ] || { echo "Missing .kimi.env (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ...)"; exit 1; }
source .kimi.env
export JARVIS_MODEL="${MODEL:-kimi-latest}"
export JARVIS_FAST_MODEL="${FAST:-}"
export PORT="${PORT:-5174}"
# Work MCP servers (Grafana, Notion...) cost latency on every turn: off by
# default. Opt in by name, e.g. JARVIS_MCP=gcp-grafana ./start-kimi.sh
export JARVIS_MCP="${JARVIS_MCP:-none}"
# With work tools on, let Claude Code load their schemas on demand instead of
# sending every one on every turn (measured: tool turns ~14s -> ~7s).
if [ "$JARVIS_MCP" != "none" ]; then
  export ENABLE_TOOL_SEARCH="${ENABLE_TOOL_SEARCH:-true}"
  # Proactive mode: with monitoring tools available, check every 10 minutes
  # while idle and speak up only if something is firing.
  export STRING_WATCH_MINUTES="${STRING_WATCH_MINUTES:-10}"
fi
# Kokoro: a modern neural voice that runs locally in the browser (WebGPU).
# Falls back to the system voice if WebGPU is unavailable. VOICE=af_heart etc.
export VITE_TTS_ENGINE="${VITE_TTS_ENGINE:-kokoro}"
export VITE_KOKORO_VOICE="${VOICE:-${VITE_KOKORO_VOICE:-bm_george}}"
# Hearing: local Whisper (whisper.cpp, Metal GPU) when it is installed and the
# model is downloaded. Works in every browser. See README for setup.
WHISPER_MODEL="${WHISPER_MODEL:-models/ggml-large-v3-turbo-q5_0.bin}"
if [ -z "${WHISPER_URL:-}" ] && command -v whisper-server >/dev/null && [ -f "$WHISPER_MODEL" ]; then
  whisper-server -m "$WHISPER_MODEL" --host 127.0.0.1 --port 8178 --convert \
    -l "${STRING_STT_LANG:-en}" > "${TMPDIR:-/tmp}/string-whisper.log" 2>&1 &
  WHISPER_PID=$!
  trap 'kill $WHISPER_PID 2>/dev/null' EXIT INT TERM
  export WHISPER_URL="http://127.0.0.1:8178"
  echo "  local Whisper starting (pid $WHISPER_PID)"
fi

npm start
