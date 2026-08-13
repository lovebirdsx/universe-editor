#!/usr/bin/env bash
#----------------------------------------------------------------------------------------------
#  WSL2/Ubuntu 一键初始化：把本仓库从零拉起，供 AI agent / 手动在 WSL 内跑 check/e2e。
#  幂等，可反复执行。
#
#  前置：WSL 原生文件系统（~/ 下）的 clone + Node 22。
#  用法（任意目录，脚本会自动定位仓库根）:
#    bash scripts/wsl/bootstrap.sh
#
#  步骤与 .github/workflows/ci.yml 的 e2e job、docs/development/wsl-e2e.md 保持一致：
#  守卫 → xvfb → corepack/pnpm → pnpm install → playwright install-deps → tsserver vendor
#  → AppArmor userns 检测 → 打印下一步。
#----------------------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

info() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; }

# --- 前置守卫：WSL + 原生文件系统 ---
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  fail "不在 WSL 环境（/proc/version 不含 microsoft）。本脚本只能在 WSL2/Ubuntu 内执行。"
  exit 1
fi

case "$REPO_ROOT" in
  /mnt/*)
    fail "仓库位于 $REPO_ROOT（/mnt 挂载盘）。跨文件系统 I/O 极慢且 inotify 不可靠，"
    fail "请 clone 到 ~/ 下再执行（详见 docs/development/wsl-e2e.md）。"
    exit 1
    ;;
esac

cd "$REPO_ROOT"

# --- Node 检查（corepack/pnpm 依赖 Node） ---
if ! command -v node >/dev/null 2>&1; then
  fail "未检测到 node。请先装 Node 22（nvm 或系统包均可），再重跑本脚本。"
  exit 1
fi
info "Node $(node -v)"

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" != "22" ]; then
  warn "Node 主版本为 $NODE_MAJOR（CI 用 22），如遇依赖/构建问题请对齐到 22。"
fi

# --- 系统依赖：xvfb（playwright install-deps 不覆盖 xvfb-run） ---
if command -v xvfb-run >/dev/null 2>&1; then
  info "xvfb 已就绪"
else
  warn "安装 xvfb（需要 sudo，可能提示输入密码）"
  sudo apt-get update
  sudo apt-get install -y xvfb
  info "xvfb 安装完成"
fi

# --- pnpm：版本跟随根 package.json 的 packageManager 字段（动态读取，不硬编码） ---
if ! command -v corepack >/dev/null 2>&1; then
  fail "未检测到 corepack（Node 16.9+ 自带）。请确认 Node 安装完整。"
  exit 1
fi
PM_SPEC="$(node -p "require('./package.json').packageManager")"
PM_SPEC="${PM_SPEC%%+*}" # 去掉 +sha512... 尾巴，得到形如 pnpm@11.10.0
corepack enable
corepack prepare "$PM_SPEC" --activate
info "pnpm $PM_SPEC 已启用"

# --- 依赖 ---
info "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

# --- Playwright 系统依赖（libnss3/libgtk 等；内部走 sudo 装 apt 包，与 CI 同款） ---
warn "playwright install-deps 内部会用 sudo 装 apt 包，可能提示输入密码"
pnpm --filter @universe-editor/editor exec playwright install-deps

# --- tsserver vendor（peek/outline 的 coreTypescriptApp fixture 需要，与 CI 一致） ---
info "npm --prefix vendor/typescript-language-server ci"
npm --prefix vendor/typescript-language-server ci

# --- Ubuntu 24.04 AppArmor userns 检测（只提示，不静默改系统配置） ---
USERRESTRICT="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
if [ "$USERRESTRICT" = "1" ]; then
  warn "kernel.apparmor_restrict_unprivileged_userns=1：Electron SUID sandbox 会报错。"
  warn "  临时放开:  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
  warn "  持久化:    写 /etc/sysctl.d/60-unprivileged-userns.conf 一行"
  warn "             kernel.apparmor_restrict_unprivileged_userns=0，再 sudo sysctl --system"
  warn "  （本脚本不自动改系统配置）"
else
  info "AppArmor userns 限制未启用（值=$USERRESTRICT）"
fi

# --- 下一步提示 ---
printf '\n'
info "初始化完成。下一步（@p0 冒烟）:"
printf '  scripts/wsl/e2e.sh pnpm e2e:smoke\n'
printf '  # 等价裸命令: xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" pnpm e2e:smoke\n'
