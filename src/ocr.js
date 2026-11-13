// Text recognition with the OCR engine built into Windows 10/11 (Windows.Media.Ocr).
// Runs offline through Windows PowerShell. Also renders PDF pages (Windows.Data.Pdf) for scanned PDFs.
// OCR language = the Windows display/input languages that have OCR installed
// (Settings > Time & language > Language > add e.g. Dutch, including "Optical character recognition").
import { execFile } from 'node:child_process';
import path from 'node:path';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($act) { $t = $asTaskAct.Invoke($null, @($act)); $t.Wait(-1) | Out-Null }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'No Windows OCR language installed' }

function Read-Stream($stream) {
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $w = $dec.PixelWidth; $h = $dec.PixelHeight
  $scale = 1.0
  if ($w -gt $max -or $h -gt $max) { $scale = [Math]::Min($max / $w, $max / $h) }
  elseif ($w -lt 1200 -and $h -lt 1200) { $scale = [Math]::Min(2.0, [Math]::Min($max / $w, $max / $h)) }  # upscale small screenshots
  $tr = New-Object Windows.Graphics.Imaging.BitmapTransform
  $tr.ScaledWidth = [uint32]([Math]::Floor($w * $scale)); $tr.ScaledHeight = [uint32]([Math]::Floor($h * $scale))
  $tr.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
  $bmp = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tr, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  ($res.Lines | ForEach-Object { $_.Text }) -join "${'`'}n"
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:BRAIN_OCR_PATH)) ([Windows.Storage.StorageFile])
if ($env:BRAIN_OCR_KIND -eq 'pdf') {
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $n = [Math]::Min([int]$doc.PageCount, [int]$env:BRAIN_OCR_MAXPAGES)
  $pages = for ($i = 0; $i -lt $n; $i++) {
    $page = $doc.GetPage($i)
    $ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opt.DestinationWidth = [uint32]2000
    AwaitAction ($page.RenderToStreamAsync($ms, $opt))
    Read-Stream $ms
    $page.Dispose()
  }
  if ($doc.PageCount -gt $n) { $pages += "[... OCR stopped after $n of $($doc.PageCount) pages]" }
  $pages -join "${'`'}n${'`'}n"
} else {
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  Read-Stream $stream
}
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

// kind: 'image' | 'pdf'. Path must be an absolute path to an existing file.
export function ocrFile(absPath, kind = 'image', maxPages = 30) {
  if (process.platform !== 'win32') return Promise.reject(new Error('OCR needs Windows'));
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
      env: { ...process.env, BRAIN_OCR_PATH: path.resolve(absPath), BRAIN_OCR_KIND: kind, BRAIN_OCR_MAXPAGES: String(maxPages) },
      maxBuffer: 50 * 1024 * 1024, timeout: 5 * 60 * 1000, windowsHide: true, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error('OCR failed: ' + cleanErr(stderr || err.message)));
      resolve(stdout.replace(/\r/g, '').trim());
    });
  });
}

// PowerShell writes errors as CLIXML when stderr is redirected; pull out the readable message.
function cleanErr(s) {
  const m = [...String(s).matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(x => x[1].replace(/_x000D__x000A_/g, ' ').trim()).filter(Boolean);
  return (m.length ? m.join(' ') : String(s)).replace(/\s+/g, ' ').slice(0, 400);
}
