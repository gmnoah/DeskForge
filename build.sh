#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo ">> 构建 DeskForge..."
pnpm build

if [[ "${1:-}" == "--package" || "${1:-}" == "-p" ]]; then
  echo ">> 打包 macOS 应用..."
  pnpm package
fi
