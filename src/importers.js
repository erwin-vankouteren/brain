// Turn dropped / watched files into captured items.
// Supported: .txt .md .log (plain notes), .eml/.msg (email), .vtt (Teams transcript), .docx (Word / Teams transcript),
// .pdf (text, or OCR when scanned), .png/.jpg (OCR)
import zlib from 'node:zlib';
import path from 'node:path';
import { parseMsg } from './msg.js';
import { ocrFile } from './ocr.js';

export const SUPPORTED = ['.txt', '.md', '.log', '.eml', '.msg', '.vtt', '.docx', '.pdf', '.png', '.jpg', '.jpeg'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg'];

const today = () => new Date().toLocaleDateString('sv-SE');
const baseName = name => path.basename(name, path.extname(name));

// filePath: absolute path of the same bytes on disk (needed for OCR).
export async function parseFile(name, buf, { mtime, filePath } = {}) {
  const ext = path.extname(name).toLowerCase();
  const fallbackDate = mtime ? new Date(mtime).toLocaleDateString('sv-SE') : today();
  switch (ext) {
    case '.eml': return { ...parseEml(decodeText(buf)), origin: name };
    case '.msg': { const m = parseMsg(buf, htmlToText); return { ...m, occurred_at: m.occurred_at || fallbackDate, origin: name }; }
    case '.pdf': return { ...(await parsePdf(buf, filePath)), title: baseName(name), source: 'document', occurred_at: fallbackDate, origin: name };
    case '.png': case '.jpg': case '.jpeg': {
      let body;
      try { body = await ocrFile(filePath, 'image'); } catch (e) { body = `[No text recognized: ${e.message}]`; }
      return { title: baseName(name), body: body || '[No text recognized in image]', source: 'other', occurred_at: fallbackDate, origin: name };
    }
    case '.vtt': return { ...parseVtt(decodeText(buf)), title: baseName(name), source: 'meeting', occurred_at: fallbackDate, origin: name };
    case '.docx': {
      const text = docxText(buf);
      const looksLikeTranscript = /transcript/i.test(name) || /^\S.*\s\d{1,2}:\d{2}(:\d{2})?\s*$/m.test(text.slice(0, 2000));
      return { title: baseName(name), body: text, source: looksLikeTranscript ? 'meeting' : 'document', occurred_at: fallbackDate, origin: name };
    }
    case '.txt': case '.md': case '.log':
      return { title: baseName(name), body: decodeText(buf).trim(), source: 'notepad', occurred_at: fallbackDate, origin: name };
    default:
      throw new Error(`Unsupported file type "${ext}". Supported: ${SUPPORTED.join(' ')}`);
  }
}

// Handles UTF-8 (with/without BOM) and UTF-16 LE/BE, which Notepad and Notepad++ can produce.
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

// ---------- Teams / WebVTT transcript
export function parseVtt(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const turns = [];
  const people = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.includes('-->')) continue;
    if (lines[i + 1] && lines[i + 1].includes('-->')) continue; // cue identifier
    let speaker = '';
    let said = line;
    const v = line.match(/^<v\s+([^>]+)>(.*?)(<\/v>)?$/);
    if (v) { speaker = v[1].trim(); said = v[2]; }
    said = said.replace(/<[^>]+>/g, '').trim();
    if (!said) continue;
    if (speaker) people.add(speaker);
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text += ' ' + said;
    else turns.push({ speaker, text: said });
  }
  return {
    body: turns.map(t => (t.speaker ? `${t.speaker}: ` : '') + t.text).join('\n\n'),
    people: [...people].join(', '),
  };
}

// ---------- Email (.eml, RFC 822 / MIME)
export function parseEml(raw) {
  const { headers, body } = splitMime(raw);
  const people = ['from', 'to', 'cc']
    .map(h => headers[h]).filter(Boolean).join(', ')
    .split(',').map(s => s.replace(/<[^>]*>/g, '').replace(/"/g, '').trim()).filter(Boolean);
  const date = headers.date ? new Date(headers.date) : null;
  let text = extractText(headers, body).trim();
  return {
    title: headers.subject || 'Email',
    body: [headers.from && `From: ${headers.from}`, headers.to && `To: ${headers.to}`, headers.cc && `Cc: ${headers.cc}`, '', text]
      .filter(x => x !== undefined && x !== null && x !== false).join('\n').trim(),
    people: [...new Set(people)].join(', '),
    source: 'email',
    occurred_at: date && !isNaN(date) ? date.toLocaleDateString('sv-SE') : today(),
  };
}

function splitMime(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!(k in headers)) headers[k] = decodeWords(line.slice(i + 1).trim());
    }
  }
  return { headers, body };
}

function extractText(headers, body) {
  const ctype = headers['content-type'] || 'text/plain';
  const boundary = ctype.match(/boundary="?([^";]+)"?/i);
  if (/^multipart\//i.test(ctype) && boundary) {
    const parts = body.split('--' + boundary[1]).slice(1).filter(p => !p.startsWith('--'));
    const parsed = parts.map(p => splitMime(p.replace(/^\r?\n/, '')));
    const pick = t => parsed.find(p => new RegExp('^' + t, 'i').test(p.headers['content-type'] || 'text/plain') && !/attachment/i.test(p.headers['content-disposition'] || ''));
    const chosen = pick('multipart/') || pick('text/plain') || pick('text/html');
    return chosen ? extractText(chosen.headers, chosen.body) : '';
  }
  const charset = (ctype.match(/charset="?([^";]+)"?/i) || [])[1] || 'utf-8';
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  let bytes;
  if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') bytes = qpDecode(body);
  else bytes = Buffer.from(body, 'latin1');
  let text;
  try { text = new TextDecoder(charset).decode(bytes); } catch { text = bytes.toString('utf8'); }
  return /^text\/html/i.test(ctype) ? htmlToText(text) : text;
}

function qpDecode(s) {
  s = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function decodeWords(s) {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=\s*/gi, (_, cs, enc, txt) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qpDecode(txt.replace(/_/g, ' '));
    try { return new TextDecoder(cs).decode(bytes); } catch { return bytes.toString('utf8'); }
  });
}

export function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// ---------- PDF: real text via pdf.js; scanned PDFs (little/no text) via Windows OCR
async function parsePdf(buf, filePath) {
  let text = '', pages = 1;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    try {
      const doc = await task.promise;
      pages = doc.numPages;
      const out = [];
      for (let i = 1; i <= pages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        out.push(tc.items.map(it => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim());
      }
      text = out.filter(Boolean).join('\n\n');
    } finally {
      await task.destroy().catch(() => {});
    }
  } catch (e) {
    text = '';
    if (!/Cannot find (module|package)/.test(e.message)) console.warn(`[pdf] text extraction failed: ${e.message}`);
  }
  if (text.replace(/\s/g, '').length >= 20 * Math.min(pages, 3)) return { body: text };
  try {
    const ocr = await ocrFile(filePath, 'pdf');
    return { body: ocr || text || '[No text found in PDF]' };
  } catch (e) {
    return { body: text || `[No text found in PDF: ${e.message}]` };
  }
}

// ---------- .docx: minimal zip reader + word/document.xml text extraction
export function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('Not a valid .docx file');
  return decodeEntities(xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim();
}

function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
