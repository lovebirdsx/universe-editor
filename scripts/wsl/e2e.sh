#!/usr/bin/env bash
#----------------------------------------------------------------------------------------------
#  xvfb 包装：离屏执行任意 e2e 命令，参数与 CI 的 xvfb-run 完全一致。
#
#  用法（任意目录，脚本会自动切到仓库根）:
#    scripts/wsl/e2e.sh pnpm e2e:smoke
#    scripts/wsl/e2e.sh pnpm e2e
#    scripts/wsl/e2e.sh pnpm --filter @universe-editor/editor e2eg "<用例标题>"
#----------------------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "$#" -eq 0 ]; then
  printf '\033[31m✗ 需要命令参数\033[0m\n' >&2
  printf '用法: scripts/wsl/e2e.sh <命令…>  例如 scripts/wsl/e2e.sh pnpm e2e:smoke\n' >&2
  exit 1
fi

cd "$REPO_ROOT"
exec xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" "$@"
