#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CONFIRMED=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--all)
      CONFIRMED=1
      ;;
  esac
done

if [[ "$CONFIRMED" -ne 1 ]]; then
  read -p "确定清理 DeskForge 的依赖和构建产物吗？(y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消。"
    exit 0
  fi
fi

echo ">> 正在清理 DeskForge 构建产物与缓存..."
rm -rf apps/desktop/dist apps/desktop/build dist out
rm -rf apps/desktop/node_modules packages/*/node_modules node_modules .pnpm-store
echo ">> 清理完成。"
