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
SQLITE_DIR="$(find node_modules/.pnpm -type d -name "better-sqlite3@*" 2>/dev/null | head -n 1 || true)"
if [[ -n "$ELECTRON_BIN" && -n "$SQLITE_DIR" ]]; then
  if ! ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "new (require('$SQLITE_DIR/node_modules/better-sqlite3'))(':memory:')" >/dev/null 2>&1; then
    echo ">> 同步原生模块至 Electron ABI..."
    REBUILD_LOG="$(mktemp -t deskforge-rebuild-XXXXXX.log 2>/dev/null || echo "/tmp/deskforge-rebuild.log")"
    if ! pnpm --filter @deskforge/desktop exec electron-rebuild -f -w better-sqlite3 >"$REBUILD_LOG" 2>&1; then
      echo "!! 原生模块 better-sqlite3 重编译失败，请检查编译环境：" >&2
      tail -n 25 "$REBUILD_LOG" >&2
      rm -f "$REBUILD_LOG"
      exit 1
    fi
    rm -f "$REBUILD_LOG"
  fi
fi

echo ">> 启动 DeskForge 桌面开发环境..."
exec pnpm dev
