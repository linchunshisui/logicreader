<#
  LogicReader — 启动诊断 / 修复（专治"双击毫无反应"）

  典型症状与真正原因（已实测确认）：
    · 以管理员身份启动过一次（窗口可能还在），之后**非管理员双击毫无反应**；
    · 没有窗口、没有对话框，连 %APPDATA%\logicreader\logs\boot.log 都不新增一行。
    原因不是"程序坏了"，而是 Chromium 的用户数据目录锁：
    提权实例独占 userData/lockfile，非管理员实例建不了锁，浏览器进程在任何 JS 之前就退出；
    非管理员也无法通知提权实例（Windows UIPI 拦截跨完整性级别的窗口消息），
    而提权再启动一次却能互相通知、于是看起来"必须用管理员权限"。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\launch-doctor.ps1          # 只读体检
    powershell -ExecutionPolicy Bypass -File scripts\launch-doctor.ps1 -Kill    # 结束所有实例（含提权的）

  注意：本文件必须保存为 UTF-8 **带 BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解码导致语法错误。
#>
[CmdletBinding()]
param(
  [switch]$Kill
)

$ErrorActionPreference = 'Continue'
$userData = Join-Path $env:APPDATA 'logicreader'
$lock = Join-Path $userData 'lockfile'
$bootLog = Join-Path $userData 'logs\boot.log'

function Write-Section([string]$text) {
  Write-Host ''
  Write-Host ('=== ' + $text + ' ===') -ForegroundColor Cyan
}

Write-Host ('用户数据目录：' + $userData)

Write-Section '1) 运行中的实例'
$procs = @(Get-Process LogicReader -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Write-Host '[√] 没有正在运行的实例' -ForegroundColor Green
} else {
  foreach ($p in $procs) {
    $elevated = '否'
    try { $null = $p.MainModule.FileName } catch { $elevated = '疑似（读不到模块信息）' }
    Write-Host ('  PID=' + $p.Id + '  启动于 ' + $p.StartTime + '  窗口标题="' + $p.MainWindowTitle + '"  提权=' + $elevated)
  }
}

Write-Section '2) 启动锁 userData/lockfile'
if (Test-Path $lock) {
  Write-Host '[!] lockfile 存在 —— 现在**非管理员双击会毫无反应**（Chromium 建锁失败即退出）' -ForegroundColor Yellow
  Write-Host '    处理：把正在运行的 LogicReader 窗口关掉；关不掉就用本脚本 -Kill。'
} else {
  Write-Host '[√] lockfile 不存在：非管理员启动不会被锁挡住' -ForegroundColor Green
}

Write-Section '3) 最近一次启动的 boot.log'
if (Test-Path $bootLog) {
  Get-Content $bootLog -Tail 8 | ForEach-Object { Write-Host ('  ' + $_) }
  $tail = Get-Content $bootLog -Tail 60
  if ($tail -match 'elevated-detected') { Write-Host '  ↑ 检测到过"以管理员身份运行"（新版本会提示并自动以普通权限重开）' -ForegroundColor Yellow }
} else {
  Write-Host '  （没有 boot.log：说明还没有任何一次成功执行到 JS，通常是启动锁被占或被安全软件拦下）'
}

if ($Kill) {
  Write-Section '4) 结束所有实例'
  if ($procs.Count -eq 0) {
    Write-Host '  没有需要结束的实例'
  } else {
    # 普通 Stop-Process 杀不掉提权实例（Access denied），走 WMI（提供程序以 SYSTEM 运行）
    Get-CimInstance Win32_Process -Filter "Name='LogicReader.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $r = Invoke-CimMethod -InputObject $_ -MethodName Terminate -Arguments @{ Reason = 0 } -ErrorAction Stop
        Write-Host ('  PID ' + $_.ProcessId + ' 已结束（ReturnValue=' + $r.ReturnValue + '）')
      } catch {
        Write-Host ('  PID ' + $_.ProcessId + ' 结束失败：' + $_.Exception.Message) -ForegroundColor Red
      }
    }
    Start-Sleep -Seconds 3
  }
  Write-Host ''
  Write-Host ('剩余实例：' + (@(Get-Process LogicReader -ErrorAction SilentlyContinue)).Count)
  Write-Host ('lockfile 仍在：' + (Test-Path $lock))
}

Write-Section '结论'
if ((Test-Path $lock) -or (@(Get-Process LogicReader -ErrorAction SilentlyContinue)).Count -gt 0) {
  Write-Host '先把实例全部结束（可以再跑一次带 -Kill 的命令），然后**直接双击 LogicReader.exe**，'
  Write-Host '不要选"以管理员身份运行" —— 新版程序在检测到提权启动时也会自己提示并改用普通权限重开。'
} else {
  Write-Host '现在可以正常双击 LogicReader.exe（普通权限即可，不需要管理员）。'
}
