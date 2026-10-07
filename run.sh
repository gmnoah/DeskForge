#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 确保 macOS 开发环境下 Electron.app 使用 DeskForge 定制图标
if [[ "$(uname -s)" == "Darwin" && -f "apps/desktop/build/icon.icns" ]]; then
  ELECTRON_ICNS="$(find node_modules -path "*/electron/dist/Electron.app/Contents/Resources/electron.icns" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$ELECTRON_ICNS" ]]; then
    cmp -s "apps/desktop/build/icon.icns" "$ELECTRON_ICNS" || cp "apps/desktop/build/icon.icns" "$ELECTRON_ICNS" 2>/dev/null || true
  fi
fi

echo ">> 启动 DeskForge 桌面开发环境..."
exec pnpm dev
