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

# 确保 better-sqlite3 符合当前 Electron ABI
ELECTRON_BIN="$(find apps/desktop/node_modules/electron/dist -name "Electron" -type f -perm +111 2>/dev/null | head -n 1 || true)"
if [[ -n "$ELECTRON_BIN" ]]; then
  if ! ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "require('./apps/desktop/node_modules/better-sqlite3')" >/dev/null 2>&1; then
    echo ">> 同步原生模块至 Electron ABI..."
    pnpm --filter @deskforge/desktop exec electron-rebuild -f -w better-sqlite3 >/dev/null 2>&1 || true
  fi
fi

echo ">> 启动 DeskForge 桌面开发环境..."
exec pnpm dev
