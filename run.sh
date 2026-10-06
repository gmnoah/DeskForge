#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo ">> 启动 DeskForge 桌面开发环境..."
exec pnpm dev
