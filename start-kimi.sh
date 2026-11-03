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
  # Run from the temp dir: --convert writes each clip of the user's voice as a
  # .wav in the working directory, which must never be the repo.
  WHISPER_MODEL_ABS="$(cd "$(dirname "$WHISPER_MODEL")" && pwd)/$(basename "$WHISPER_MODEL")"
  ( cd "${TMPDIR:-/tmp}" && exec whisper-server -m "$WHISPER_MODEL_ABS" --host 127.0.0.1 --port 8178 --convert \
    -l "${STRING_STT_LANG:-en}" ) > "${TMPDIR:-/tmp}/string-whisper.log" 2>&1 &
  WHISPER_PID=$!
  export WHISPER_URL="http://127.0.0.1:8178"
  echo "  local Whisper starting (pid $WHISPER_PID)"
fi

# Voice: Kokoro on the Mac's GPU via an mlx-audio server (~0.2s per sentence),
# when its environment is set up (.venv-tts; see README). Same voice ids as
# VOICE=…, e.g. bm_george, af_heart.
if [ -z "${LOCAL_TTS_URL:-}" ] && [ -x .venv-tts/bin/python ]; then
  .venv-tts/bin/python -m mlx_audio.server --host 127.0.0.1 --port 8179 \
    > "${TMPDIR:-/tmp}/zen-voice.log" 2>&1 &
  VOICE_PID=$!
  export LOCAL_TTS_URL="http://127.0.0.1:8179"
  export LOCAL_TTS_VOICE="${VOICE:-bm_george}"
  echo "  local voice starting (pid $VOICE_PID)"
  # The first sentence loads the model (~9s); pay that now, not mid-answer.
  ( for i in $(seq 1 60); do curl -s -o /dev/null "$LOCAL_TTS_URL/" && break; sleep 1; done
    curl -s -o /dev/null -X POST "$LOCAL_TTS_URL/v1/audio/speech" -H 'content-type: application/json' \
      -d "{\"model\":\"prince-canuma/Kokoro-82M\",\"input\":\"Ready.\",\"voice\":\"$LOCAL_TTS_VOICE\",\"response_format\":\"mp3\"}" ) &
fi
trap 'kill ${WHISPER_PID:-} ${VOICE_PID:-} 2>/dev/null' EXIT INT TERM

npm start
