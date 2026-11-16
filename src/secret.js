// Protect secrets (the SQL password of a cloud brain) with Windows DPAPI.
// The encrypted value can only be decrypted by the same Windows user on the same machine,
// so brains.json never contains a readable password.
import { execFile } from 'node:child_process';

function ps(script, secret) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Storing passwords needs Windows (DPAPI)'));
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { env: { ...process.env, BRAIN_SECRET: secret }, windowsHide: true, encoding: 'utf8', timeout: 30000 },
      (err, stdout) => err ? reject(new Error('Could not protect/unprotect the password with Windows DPAPI')) : resolve(stdout.replace(/\r?\n$/, '')));
  });
}

export const protect = plain =>
  ps(`ConvertTo-SecureString $env:BRAIN_SECRET -AsPlainText -Force | ConvertFrom-SecureString`, plain);

export const unprotect = blob =>
  ps(`$s = ConvertTo-SecureString $env:BRAIN_SECRET; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`, blob);
