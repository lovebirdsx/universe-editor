# -----------------------------------------------------------------------------------------------
#  Windows 一键入口：装 Node（缺则 winget 装）→ 调 setup.mjs 把 server.mjs 注册成计划任务。
#
#  用法（以管理员身份打开 PowerShell，在本目录）:
#    ./setup.ps1                         # 安装并启动（默认 C:\universe-editor\data, 80 端口）
#    ./setup.ps1 uninstall               # 卸载任务（保留发布目录）
#    ./setup.ps1 status                  # 查看任务状态
#    ./setup.ps1 install --port 8080 --base /ue/   # 自定义
#
#  若提示脚本被禁止运行: PowerShell 里先跑
#    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# -----------------------------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 管理员自检（80 端口、计划任务、防火墙都需要）。
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "`e[31m✗ 请以管理员身份运行 PowerShell（80 端口、计划任务、防火墙需要）`e[0m"
  exit 1
}

function Resolve-NodeExe {
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $candidate) { return $candidate }
  $where = (& where.exe node 2>$null | Select-Object -First 1)
  if ($where) { return $where.Trim() }
  return $null
}

$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
  Write-Host "  未检测到 Node，正在用 winget 安装 Node.js LTS…"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "`e[31m✗ 未找到 winget。请手动安装 Node.js（https://nodejs.org/）后重跑。`e[0m"
    exit 1
  }
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $nodeExe = Resolve-NodeExe
  if (-not $nodeExe) {
    Write-Host "`e[31m✗ Node 安装后仍未找到 node.exe，请重开 PowerShell 重试。`e[0m"
    exit 1
  }
}
Write-Host "  Node 已就绪: $nodeExe"

# 透传所有参数给跨平台部署逻辑。
& $nodeExe (Join-Path $ScriptDir 'setup.mjs') @args
exit $LASTEXITCODE
