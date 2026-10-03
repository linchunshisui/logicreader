<#
  LogicReader 启动器（由「启动逻辑阅读器.cmd」调用，也可直接右键用 PowerShell 运行）

  为什么需要它：个别机器的安全策略会拦死未签名程序的几种关键能力 ——
    A. ShellExecute（双击/资源管理器/Start-Process）直接卡住，进程根本没被创建；
    B. 不带 --no-sandbox 时，Chromium 沙箱初始化在界面出现之前崩溃（秒退、无日志）；
    C. 对 C: 盘用户目录（含 %APPDATA%）的写入被拒，程序连日志都写不出来。
  这些都发生在程序自己的代码运行之前，应用内部无法自愈，只能从外部换启动形态。

  实现要点：
    · 用 ProcessStartInfo（UseShellExecute=false，即 CreateProcess）拉起程序 ——
      ShellExecuteEx 在故障机器上会卡死，PowerShell 的 Start-Process 默认就走它（实测）；
    · 按三档依次尝试：主窗口出现才算成功；进程秒退或 8 秒无窗口就降一档；
    · 三档都不需要管理员权限：
        1) 正常模式                —— 健康机器直接用这档；
        2) 关闭沙箱                —— 应对 B（与应用内的降级记忆一致）；
        3) 关闭沙箱 + 便携数据目录 —— 应对 B+C：数据改存到 release\userdata（程序目录旁），
                                     文档仍在原处、读取不受影响（实测只拦写入、不拦读取）。

  每次尝试写 launcher.log（与本文件同目录），失败排查先看它。
  注意：本文件必须保持 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会把中文按 ANSI 解码出错。
#>
$ErrorActionPreference = 'SilentlyContinue'
$exe = Join-Path $PSScriptRoot 'LogicReader.exe'
$log = Join-Path $PSScriptRoot 'launcher.log'
$userDataFallback = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\userdata'))

function Write-Log([string]$msg) {
  try { Add-Content -Path $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg) -Encoding UTF8 } catch { }
}

function Test-Launch([string]$cmdArgs, [string]$label) {
  Write-Log ('尝试启动（' + $label + '）' + $(if ($cmdArgs) { ' 参数：' + $cmdArgs } else { '' }))
  $p = $null
  try {
    # 不用 Start-Process：它默认走 ShellExecuteEx，在故障机器上会卡死（实测）。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.UseShellExecute = $false
    if ($cmdArgs) { $psi.Arguments = $cmdArgs }
    $p = [System.Diagnostics.Process]::Start($psi)
  } catch {
    Write-Log ('启动异常（' + $label + '）：' + $_.Exception.Message)
    return $false
  }
  if ($null -eq $p) {
    Write-Log ('启动失败（' + $label + '）：进程对象为空')
    return $false
  }
  # 主窗口句柄出现 = 真的起来了；进程退出或 8 秒无窗口 = 失败降档
  for ($i = 0; $i -lt 16; $i++) {
    if ($p.HasExited) {
      Write-Log ('秒退（' + $label + '），退出码=' + $p.ExitCode)
      return $false
    }
    $p.Refresh()
    if ($p.MainWindowHandle -ne 0) {
      Write-Log ('成功（' + $label + '），PID=' + $p.Id)
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  try { $p.Kill() } catch { }
  Write-Log ('超时未出窗口（' + $label + '），已结束进程')
  return $false
}

if (-not (Test-Path $exe)) {
  Write-Log '找不到 LogicReader.exe —— 启动器必须放在 LogicReader.exe 同目录'
  exit 1
}

if (Test-Launch '' '正常模式') { exit 0 }
if (Test-Launch '--no-sandbox' '兼容模式（关闭沙箱）') { exit 0 }
if (Test-Launch ('--no-sandbox --user-data-dir="' + $userDataFallback + '"') '便携模式（关沙箱+数据存到程序目录旁）') { exit 0 }

Write-Log '三档全部失败：请把 launcher.log 与 %APPDATA%\logicreader\logs\boot.log 一并发给开发者'
Add-Type -AssemblyName PresentationFramework
[void][System.Windows.MessageBox]::Show(
  "LogicReader 在本机的三种启动形态都被系统拦下了。`n`n请把以下日志发给开发者：`n· " + $log + "`n· %APPDATA%\logicreader\logs\boot.log`n`n若愿意授权一次管理员：在项目目录的管理员 PowerShell 里运行`n  pnpm trust:windows -- -AddExclusion`n把程序加入 Defender 排除项后，双击 LogicReader.exe 即可直接打开。",
  'LogicReader 启动失败', 'OK', 'Warning')
exit 1