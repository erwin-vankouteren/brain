<#
.SYNOPSIS
  Back up the local brains (SQLite database + imported original files) to timestamped zips.

.DESCRIPTION
  Reads brains.json and backs up every *local* brain, or only the one given with -Brain.
  Cloud (Azure SQL) brains are skipped: Azure SQL keeps its own automatic backups.
  Takes a consistent snapshot with SQLite's VACUUM INTO, so it is safe to run while the app is running.
  The snapshot is integrity-checked before it is zipped.
  Result per brain: <Destination>\brain-backup-<brain id>-yyyy-MM-dd_HHmmss.zip containing brain.db and files\

.PARAMETER Brain
  Id of one brain to back up (see brains.json). Default: all local brains.

.PARAMETER Destination
  Folder to write backups to. Default: the "backups" folder next to this script.

.PARAMETER DatabaseOnly
  Only back up brain.db, not the stored original files (PDFs, images, mails, ...).

.PARAMETER Keep
  Keep only the newest N backups per brain in the destination folder and delete older ones. 0 (default) keeps all.

.EXAMPLE
  .\backup-brain.ps1

.EXAMPLE
  .\backup-brain.ps1 -Brain work -Destination "D:\Backups\Brain" -Keep 14

.NOTES
  Restore: stop the app, unzip, then copy brain.db and the files folder back to the brain's data folder
  (shown at app start-up and in Manage brains).
#>
[CmdletBinding()]
param(
  [string]$Brain,
  [string]$Destination = (Join-Path $PSScriptRoot 'backups'),
  [switch]$DatabaseOnly,
  [ValidateRange(0, 100000)][int]$Keep = 0
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found on PATH.' }

# ---- which brains? (same rules as the app: brains.json, or the original single database)
$home_ = if ($env:BRAIN_HOME) { $env:BRAIN_HOME } else { $PSScriptRoot }
$registry = Join-Path $home_ 'brains.json'
if (Test-Path -LiteralPath $registry) {
  $all = @((Get-Content -LiteralPath $registry -Raw -Encoding UTF8 | ConvertFrom-Json).brains)
} else {
  $db = if ($env:BRAIN_DB) { $env:BRAIN_DB } else { 'data\brain.db' }
  $all = @([pscustomobject]@{ id = 'work'; name = 'Work brain'; type = 'local'; db = $db })
}
if ($Brain) {
  $all = @($all | Where-Object { $_.id -eq $Brain })
  if (-not $all.Count) { throw "No brain with id '$Brain' in $registry" }
}
foreach ($b in $all | Where-Object { $_.type -ne 'local' }) {
  Write-Host "Skipping cloud brain '$($b.name)' ($($b.server)/$($b.database)): Azure SQL keeps its own automatic backups." -ForegroundColor DarkGray
}
$targets = @($all | Where-Object { $_.type -eq 'local' })
if (-not $targets.Count) { Write-Host 'No local brains to back up.'; return }

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path

# Consistent snapshot + integrity check, using Node's built-in SQLite
$snapshotJs = @'
const { DatabaseSync } = require('node:sqlite');
const [src, dst] = process.argv.slice(2);
const db = new DatabaseSync(src);
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(dst);
db.close();
const chk = new DatabaseSync(dst, { readOnly: true });
const result = Object.values(chk.prepare('PRAGMA integrity_check').get())[0];
if (result !== 'ok') { console.error('Integrity check failed: ' + result); process.exit(2); }
const tables = chk.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('thoughts','items','actions','weblinks')").all().map(r => r.name);
console.log(tables.map(t => t + ': ' + chk.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n).join(', '));
chk.close();
'@

$failed = 0
foreach ($b in $targets) {
  $db = if ([IO.Path]::IsPathRooted($b.db)) { [IO.Path]::GetFullPath($b.db) } else { [IO.Path]::GetFullPath((Join-Path $home_ $b.db)) }
  if (-not (Test-Path -LiteralPath $db)) { Write-Warning "[$($b.name)] database not found: $db"; $failed++; continue }
  $filesDir = Join-Path (Split-Path -Parent $db) 'files'
  $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
  $zip = Join-Path $Destination "brain-backup-$($b.id)-$stamp.zip"
  $work = Join-Path ([IO.Path]::GetTempPath()) "brain-backup-$($b.id)-$stamp"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    $script = Join-Path $work 'snapshot.cjs'
    $snapshotJs | Set-Content -LiteralPath $script -Encoding ASCII
    $counts = & node --disable-warning=ExperimentalWarning $script $db (Join-Path $work 'brain.db')
    if ($LASTEXITCODE -ne 0) { throw "Snapshot failed (exit code $LASTEXITCODE)." }
    Remove-Item -LiteralPath $script

    $fileCount = 0
    if (-not $DatabaseOnly -and (Test-Path -LiteralPath $filesDir)) {
      $items = @(Get-ChildItem -LiteralPath $filesDir -File | Where-Object { $_.Name -notlike 'tmp-*' })
      if ($items.Count) {
        $target = New-Item -ItemType Directory -Force -Path (Join-Path $work 'files')
        $items | Copy-Item -Destination $target.FullName
        $fileCount = $items.Count
      }
    }
    Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -CompressionLevel Optimal

    $removed = 0
    if ($Keep -gt 0) {
      $old = Get-ChildItem -LiteralPath $Destination -Filter "brain-backup-$($b.id)-*.zip" | Sort-Object Name -Descending | Select-Object -Skip $Keep
      foreach ($f in $old) { Remove-Item -LiteralPath $f.FullName; $removed++ }
    }

    $sizeMb = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
    Write-Host "[$($b.name)] backup created: $zip ($sizeMb MB)" -ForegroundColor Green
    Write-Host "  Database:  $db"
    Write-Host "  Contents:  $counts"
    if ($DatabaseOnly) { Write-Host '  Files:     skipped (-DatabaseOnly)' } else { Write-Host "  Files:     $fileCount original file(s)" }
    if ($removed) { Write-Host "  Removed $removed old backup(s), keeping the newest $Keep." }
  }
  catch { Write-Warning "[$($b.name)] backup failed: $($_.Exception.Message)"; $failed++ }
  finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($failed) { exit 1 }
