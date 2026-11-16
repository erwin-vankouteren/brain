<#
.SYNOPSIS
  Back up the Brain database (and the imported original files) to a timestamped zip.

.DESCRIPTION
  Takes a consistent snapshot with SQLite's VACUUM INTO, so it is safe to run while the app is running.
  The snapshot is integrity-checked before it is zipped.
  Result: <Destination>\brain-backup-yyyy-MM-dd_HHmmss.zip containing brain.db and files\

.PARAMETER Destination
  Folder to write backups to. Default: the "backups" folder next to this script.

.PARAMETER DatabaseOnly
  Only back up brain.db, not data\files (the stored original PDFs, images, mails, ...).

.PARAMETER Keep
  Keep only the newest N backups in the destination folder and delete older ones. 0 (default) keeps all.

.EXAMPLE
  .\backup-brain.ps1

.EXAMPLE
  .\backup-brain.ps1 -Destination "D:\Backups\Brain" -Keep 14

.NOTES
  Restore: stop the app, unzip, then copy brain.db to data\brain.db and the files folder to data\files.
#>
[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $PSScriptRoot 'backups'),
  [switch]$DatabaseOnly,
  [ValidateRange(0, 100000)][int]$Keep = 0
)

$ErrorActionPreference = 'Stop'

# Same location rules as the app: BRAIN_DB environment variable, otherwise data\brain.db
$db = if ($env:BRAIN_DB) { $env:BRAIN_DB } else { Join-Path $PSScriptRoot 'data\brain.db' }
$db = [IO.Path]::GetFullPath($db)
if (-not (Test-Path -LiteralPath $db)) { throw "Database not found: $db" }
$filesDir = Join-Path (Split-Path -Parent $db) 'files'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found on PATH.' }

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$zip = Join-Path $Destination "brain-backup-$stamp.zip"
$work = Join-Path ([IO.Path]::GetTempPath()) "brain-backup-$stamp"
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
  # 1. Consistent snapshot + integrity check (done in Node's built-in SQLite)
  $script = Join-Path $work 'snapshot.cjs'
  @'
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
'@ | Set-Content -LiteralPath $script -Encoding ASCII

  $snapshot = Join-Path $work 'brain.db'
  $counts = & node --disable-warning=ExperimentalWarning $script $db $snapshot
  if ($LASTEXITCODE -ne 0) { throw "Snapshot failed (exit code $LASTEXITCODE)." }
  Remove-Item -LiteralPath $script

  # 2. Original imported files
  $fileCount = 0
  if (-not $DatabaseOnly -and (Test-Path -LiteralPath $filesDir)) {
    $items = @(Get-ChildItem -LiteralPath $filesDir -File | Where-Object { $_.Name -notlike 'tmp-*' })
    if ($items.Count) {
      $target = New-Item -ItemType Directory -Force -Path (Join-Path $work 'files')
      $items | Copy-Item -Destination $target.FullName
      $fileCount = $items.Count
    }
  }

  # 3. Zip
  Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -CompressionLevel Optimal
}
finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# 4. Prune old backups
$removed = 0
if ($Keep -gt 0) {
  $old = Get-ChildItem -LiteralPath $Destination -Filter 'brain-backup-*.zip' | Sort-Object Name -Descending | Select-Object -Skip $Keep
  foreach ($f in $old) { Remove-Item -LiteralPath $f.FullName; $removed++ }
}

$sizeMb = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
Write-Host "Backup created: $zip ($sizeMb MB)" -ForegroundColor Green
Write-Host "  Database:  $db"
Write-Host "  Contents:  $counts"
if ($DatabaseOnly) { Write-Host '  Files:     skipped (-DatabaseOnly)' } else { Write-Host "  Files:     $fileCount original file(s)" }
if ($removed) { Write-Host "  Removed $removed old backup(s), keeping the newest $Keep." }
