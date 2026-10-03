<#
  LogicReader — 创建/刷新「桌面 + 开始菜单」快捷方式。

  为什么需要它：
    · 产物不在工作区内（工作区根目录被沙箱打了 Low 完整性标签，里面的 exe 双击必崩，
      见避坑指南 §2.12），日常启动靠的是 `D:\Apps\LogicReader\LogicReader.exe`；
    · 而「开始菜单 / 桌面」两处快捷方式以前是手工建的 —— 换了发布目录就得重来，
      也不容易发现"开始菜单里根本没有"这件事（本轮就是这么发现的）。
    于是把它固化成脚本：每次 `pnpm publish:local` 之后跑一次即可。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1 -Remove

  不需要管理员权限：开始菜单写的是**当前用户**的
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs`（Windows 11 的"所有应用"会读它）。
#>
[CmdletBinding()]
param(
  [string]$PublishDir = 'D:\Apps\LogicReader',
  [string]$Name = '逻辑阅读器',
  [string]$Description = '逻辑阅读器 - 本地阅读与知识图谱',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $PublishDir 'LogicReader.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

$targets = @(
  (Join-Path $desktop ($Name + '.lnk')),
  (Join-Path $startMenu ($Name + '.lnk'))
)

if ($Remove) {
  foreach ($path in $targets) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
      Write-Host ('[shortcut] 已删除 ' + $path)
    }
  }
  return
}

if (-not (Test-Path -LiteralPath $exe)) {
  throw ('未找到 ' + $exe + '：请先执行 pnpm build:unpack 与 pnpm publish:local')
}
if (-not (Test-Path -LiteralPath $startMenu)) {
  throw ('未找到开始菜单目录：' + $startMenu)
}

$shell = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $exe
  $link.WorkingDirectory = $PublishDir
  $link.IconLocation = ($exe + ',0')
  $link.Description = $Description
  # 1 = 常规窗口（不要最大化 / 最小化：阅读器自己恢复上次的窗口几何）
  $link.WindowStyle = 1
  $link.Save()
}

# 回读校验：写进去的和读出来的一致，才算成功（Start 菜单只认落盘的文件）
$failed = @()
foreach ($path in $targets) {
  if (-not (Test-Path -LiteralPath $path)) {
    $failed += ($path + '（没有落盘）')
    continue
  }
  $check = $shell.CreateShortcut($path)
  if ($check.TargetPath -ne $exe -or $check.WorkingDirectory -ne $PublishDir) {
    $failed += ($path + '（目标不符：' + $check.TargetPath + '）')
  }
}

if ($failed.Count -gt 0) {
  throw ('快捷方式校验失败：' + ($failed -join '；'))
}

Write-Host '[shortcut] 桌面：' $targets[0]
Write-Host '[shortcut] 开始菜单：' $targets[1]
Write-Host ('[shortcut] 目标：' + $exe + '（可直接在开始菜单里搜「' + $Name + '」或 LogicReader）')
