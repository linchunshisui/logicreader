<#
  LogicReader — Windows 安全提示处理脚本

  背景：产物未做代码签名时，Windows 会把它标成"未知发布者"：
    · 从网络/聊天工具拿到的 exe 会弹"Windows 已保护你的电脑"（SmartScreen，需要"仍要运行"）；
    · 少数机器上安全软件会对未签名的大体积 exe 报误报。
  本脚本把三类处理动作集中起来，默认只做**只读体检**，不会改动任何东西。

  用法（普通用户，只读体检 + 用 Defender 实测扫描产物）：
    powershell -ExecutionPolicy Bypass -File scripts\trust-windows.ps1 -Scan

  用法（普通用户，解除"来自 Internet"的锁定，消除 SmartScreen 提示）：
    powershell -ExecutionPolicy Bypass -File scripts\trust-windows.ps1 -Unblock

  用法（**管理员**，给程序目录加 Defender 排除项，误报时用）：
    powershell -ExecutionPolicy Bypass -File scripts\trust-windows.ps1 -AddExclusion

  注意：本文件必须保存为 UTF-8 **带 BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解码，
        中文注释会乱码并连带把字符串引号拆坏（实测报 Missing closing '}'）。

  参数：
    -Path <目录>     默认 ..\release\win-unpacked
    -Unblock         递归解除文件锁定（Unblock-File，不需要管理员）
    -AddExclusion    添加 Defender 排除项（需要管理员；可能被"篡改防护"拦住）
    -Scan            调用 MpCmdRun 对产物做一次自定义扫描（只读，-DisableRemediation）
#>
[CmdletBinding()]
param(
  [string]$Path,
  [switch]$Unblock,
  [switch]$AddExclusion,
  [switch]$Scan
)

$ErrorActionPreference = 'Continue'

if (-not $Path) {
  $Path = Join-Path (Split-Path -Parent $PSScriptRoot) 'release\win-unpacked'
}
if (-not (Test-Path $Path)) {
  Write-Host ('[x] 找不到目录：' + $Path) -ForegroundColor Red
  Write-Host '    先执行 pnpm build:unpack（或 build:win）生成产物。'
  exit 1
}
$Path = (Resolve-Path $Path).Path
$exe = Join-Path $Path 'LogicReader.exe'

function Write-Section([string]$text) {
  Write-Host ''
  Write-Host ('=== ' + $text + ' ===') -ForegroundColor Cyan
}

Write-Host ('目标目录：' + $Path)

# ------------------------------------------------------------------ 只读体检
Write-Section '1) 签名状态（决定 Windows 是否显示"未知发布者"）'
if (Test-Path $exe) {
  $sig = Get-AuthenticodeSignature $exe
  switch ($sig.Status) {
    'Valid' {
      Write-Host ('[√] 已签名：' + $sig.SignerCertificate.Subject) -ForegroundColor Green
      Write-Host ('    有效期至：' + $sig.SignerCertificate.NotAfter)
    }
    'NotSigned' {
      Write-Host '[!] 未签名 —— 这就是 Windows 判"风险/未知发布者"的根本原因' -ForegroundColor Yellow
      Write-Host '    根治办法只有一个：用代码签名证书签名（见本文件末尾）。'
    }
    default {
      Write-Host ('[!] 签名状态异常：' + $sig.Status + ' ' + $sig.StatusMessage) -ForegroundColor Yellow
    }
  }
} else {
  Write-Host ('[x] 目录里没有 LogicReader.exe') -ForegroundColor Red
}

Write-Section '2) 文件锁定（Mark-of-the-Web，SmartScreen 弹窗的直接原因）'
$locked = Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { (Get-Item $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) } |
  Select-Object -ExpandProperty FullName
if ($locked) {
  Write-Host ('[!] ' + $locked.Count + ' 个文件带"来自 Internet"标记，运行时会弹"Windows 已保护你的电脑"') -ForegroundColor Yellow
  $locked | Select-Object -First 5 | ForEach-Object { Write-Host ('    ' + $_) }
  Write-Host '    处理：加 -Unblock 参数重新运行（不需要管理员）。'
} else {
  Write-Host '[√] 没有文件被锁定（本机产物不会触发 SmartScreen 弹窗）' -ForegroundColor Green
}

Write-Section '3) 安全中心状态'
try {
  $st = Get-MpComputerStatus
  Write-Host ('实时保护：' + $st.RealTimeProtectionEnabled + ' ｜ 篡改防护：' + $st.IsTamperProtected + ' ｜ 病毒库：' + $st.AntivirusSignatureVersion)
  $pref = Get-MpPreference
  Write-Host ('可能不需要的应用(PUA)阻止：' + $pref.PUAProtection + '（1=开启；开启时对未签名程序更敏感）')
} catch {
  Write-Host ('读取安全中心状态失败：' + $_.Exception.Message)
}

# ------------------------------------------------------------------ 可选动作
if ($Unblock) {
  Write-Section '4) 解除文件锁定'
  $n = 0
  Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    try { Unblock-File -LiteralPath $_.FullName -ErrorAction Stop; $n++ } catch { }
  }
  Write-Host ('[√] 已对 ' + $n + ' 个文件执行 Unblock-File') -ForegroundColor Green
}

if ($AddExclusion) {
  Write-Section '5) 添加 Defender 排除项'
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Host '[x] 需要管理员权限：请用"以管理员身份运行"的 PowerShell 重新执行本命令' -ForegroundColor Red
  } else {
    try {
      Add-MpPreference -ExclusionPath $Path -ErrorAction Stop
      Add-MpPreference -ExclusionProcess 'LogicReader.exe' -ErrorAction Stop
      Write-Host ('[√] 已排除目录：' + $Path + ' 与进程 LogicReader.exe') -ForegroundColor Green
      Write-Host '    注意：这是"本机不再误报"的权宜之计，不能替代代码签名。'
    } catch {
      Write-Host ('[x] 添加失败：' + $_.Exception.Message) -ForegroundColor Red
      Write-Host '    若提示被"篡改防护"阻止，请在 设置 → 隐私和安全性 → Windows 安全中心 →' -ForegroundColor Yellow
      Write-Host '    病毒和威胁防护 → 管理设置 → 排除项 里手动添加该目录。' -ForegroundColor Yellow
    }
  }
}

if ($Scan) {
  Write-Section '6) 用本机 Defender 实测扫描产物（只读，不改动文件）'
  $mp = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
  if (Test-Path $mp) {
    & $mp -Scan -ScanType 3 -File $Path -DisableRemediation
    Write-Host ('MpCmdRun 退出码：' + $LASTEXITCODE + '（0 且提示 found no threats == 病毒库不认为产物有问题）')
  } else {
    Write-Host '[!] 未找到 MpCmdRun.exe，跳过'
  }
}

# ------------------------------------------------------------------ 结论与指引
Write-Section '结论与后续'
Write-Host '· 若第 1 项显示"未签名"，Windows 在任何缺少信誉的机器上都会显示"未知发布者/风险"，'
Write-Host '  这与程序行为无关 —— 唯一根治手段是代码签名：'
Write-Host '    set CSC_LINK=D:\cert\logicreader.pfx'
Write-Host '    set CSC_KEY_PASSWORD=***'
Write-Host '    pnpm build:win'
Write-Host '· 证书获取途径：商业 OV/EV 证书、Azure Trusted Signing（按量付费），'
Write-Host '  或面向开源项目的免费计划（SignPath Foundation / Certum Open Source）。'
Write-Host '· 若确认是杀软"误报"（本机病毒库扫描无威胁却仍被拦），'
Write-Host '  请把 exe 提交微软复核：https://www.microsoft.com/en-us/wdsi/filesubmission'
Write-Host '  （选择"提交文件"→ 类别选"软件开发者/误报"，一般 24-72 小时出结果）'
