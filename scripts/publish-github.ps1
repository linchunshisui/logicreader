# Publish this repository to GitHub, then attach the portable package as a Release asset.
#
# One-time prerequisites:
#   winget install --id GitHub.cli -e      # install GitHub CLI
#   gh auth login                          # sign in (browser)
#
# Usage:
#   pnpm publish:github -- -Repo <owner>/<name> [-Visibility public|private]
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes a BOM-less .ps1
#       as ANSI, so non-ASCII comments/strings here would be corrupted (see 避坑指南 §24.4).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [ValidateSet('public', 'private')][string]$Visibility = 'public',
  [string]$Tag = 'v0.1.0',
  [string]$Title = 'LogicReader v0.1.0',
  [string]$Asset = 'release\LogicReader-0.1.0-portable.zip',
  [string]$Notes = '',
  [string]$Description = 'Local document reader that turns PDF / Markdown / Word / Excel into an interactive logic graph'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh) not found. Install it with:  winget install --id GitHub.cli -e'
}
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'Not signed in to GitHub. Run:  gh auth login' }

if (-not (Test-Path -LiteralPath $Asset)) {
  throw "Release asset not found: $Asset. Build it first with:  pnpm build:unpack  (then zip release\win-unpacked)"
}

$remotes = @(git remote)
if ($remotes -contains 'origin') {
  Write-Host '[publish-github] remote origin exists, pushing...'
  git push -u origin main
} else {
  Write-Host "[publish-github] creating $Visibility repo $Repo and pushing..."
  gh repo create $Repo --$Visibility --description $Description --source . --remote origin --push
}

if ($Notes -and (Test-Path -LiteralPath $Notes)) {
  gh release create $Tag $Asset --title $Title --notes-file $Notes
} else {
  gh release create $Tag $Asset --title $Title --notes 'Portable Windows build: unzip and run LogicReader.exe (no install, no admin rights).'
}

Write-Host '[publish-github] done: source pushed, release asset uploaded.'
