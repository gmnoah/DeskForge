#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo ">> 构建 DeskForge..."
pnpm build

if [[ "${1:-}" == "--package" || "${1:-}" == "-p" ]]; then
  echo ">> 打包 macOS 应用..."
  pnpm package

  if [[ "${NOAH_COPY_APPS:-1}" != "0" ]]; then
    APPS_DIR="${NOAH_APPS_DIR:-$ROOT/../../应用程序}/12_DeskForge"
    echo ">> 复制分发产物到 $APPS_DIR ..."
    mkdir -p "$APPS_DIR"

    APP_BUNDLE="$(find "$ROOT/outputs/release" -name "DeskForge.app" -type d 2>/dev/null | head -n 1 || true)"
    if [[ -n "$APP_BUNDLE" && -d "$APP_BUNDLE" ]]; then
      rm -rf "$APPS_DIR/DeskForge.app"
      cp -R "$APP_BUNDLE" "$APPS_DIR/DeskForge.app"
      echo ">> 已同步 DeskForge.app -> $APPS_DIR/DeskForge.app"
    fi

    for file in "$ROOT/outputs/release"/DeskForge*.dmg "$ROOT/outputs/release"/DeskForge*.zip; do
      if [[ -f "$file" ]]; then
        cp -f "$file" "$APPS_DIR/"
        echo ">> 已同步 $(basename "$file") -> $APPS_DIR/"
      fi
    done
  fi
fi
