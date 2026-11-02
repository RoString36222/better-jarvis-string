#!/bin/bash
# Runs JARVIS on the org's Kimi gateway. Credentials live in .kimi.env (git-ignored).
#   ./start-kimi.sh                 Kimi for everything
#   FAST=<model> ./start-kimi.sh    Kimi + a fast model for face commands and small talk
cd "$(dirname "$0")"
[ -f .kimi.env ] || { echo "Missing .kimi.env (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ...)"; exit 1; }
source .kimi.env
export JARVIS_MODEL="${MODEL:-kimi-latest}"
export JARVIS_FAST_MODEL="${FAST:-}"
export PORT="${PORT:-5174}"
exec npm start
