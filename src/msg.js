// Minimal reader for Outlook .msg files (OLE Compound File Binary + MAPI properties).
// Extracts subject, sender, recipients, date, body (plain text, or HTML converted) and attachment names.

const END = 0xfffffffa; // sector ids >= this are special (ENDOFCHAIN, FREESECT, ...)

function readCfb(buf) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) throw new Error('Not an Outlook .msg file');
  const secSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const firstDir = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  let difatSec = buf.readUInt32LE(0x44);
  const sector = id => buf.subarray((id + 1) * secSize, (id + 2) * secSize);

  // FAT sector list: 109 entries in the header, then the DIFAT chain
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = buf.readUInt32LE(0x4c + i * 4); if (s < END) fatSectors.push(s); }
  for (let guard = 0; difatSec < END && guard < 10000; guard++) {
    const s = sector(difatSec);
    for (let i = 0; i < secSize / 4 - 1; i++) { const v = s.readUInt32LE(i * 4); if (v < END) fatSectors.push(v); }
    difatSec = s.readUInt32LE(secSize - 4);
  }
  const fat = [];
  for (const fs of fatSectors) { const s = sector(fs); for (let i = 0; i < secSize; i += 4) fat.push(s.readUInt32LE(i)); }

  const chain = (start, table) => {
    const out = [];
    for (let id = start, guard = 0; id < END && guard < table.length + 1; guard++) { out.push(id); id = table[id]; }
    return out;
  };
  const readBig = (start, size) => Buffer.concat(chain(start, fat).map(sector)).subarray(0, size);

  // directory
  const dirBuf = readBig(firstDir, Infinity);
  const entries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const e = dirBuf.subarray(off, off + 128);
    const nameLen = e.readUInt16LE(0x40);
    entries.push({
      name: nameLen > 2 ? e.toString('utf16le', 0, nameLen - 2) : '',
      type: e[0x42], left: e.readUInt32LE(0x44), right: e.readUInt32LE(0x48), child: e.readUInt32LE(0x4c),
      start: e.readUInt32LE(0x74), size: e.readUInt32LE(0x78),
    });
  }
  const root = entries[0];
  const miniStream = readBig(root.start, root.size);
  const miniFatBuf = firstMiniFat < END ? readBig(firstMiniFat, Infinity) : Buffer.alloc(0);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) miniFat.push(miniFatBuf.readUInt32LE(i));

  const read = e => e.size < cutoff
    ? Buffer.concat(chain(e.start, miniFat).map(id => miniStream.subarray(id * miniSize, (id + 1) * miniSize))).subarray(0, e.size)
    : readBig(e.start, e.size);

  // children of a storage = in-order walk of its red-black tree
  const children = idx => {
    const out = [];
    const walk = i => { if (i >= END || !entries[i] || out.length > 10000) return; walk(entries[i].left); out.push(entries[i]); walk(entries[i].right); };
    walk(entries[idx].child);
    return out;
  };
  return { entries, root: 0, children, read, indexOf: e => entries.indexOf(e) };
}

function props(cfb, storageIdx) {
  const map = new Map();
  for (const e of cfb.children(storageIdx)) map.set(e.name, e);
  const str = id => {
    const u = map.get(`__substg1.0_${id}001F`);
    if (u) return cfb.read(u).toString('utf16le').replace(/\0+$/, '');
    const a = map.get(`__substg1.0_${id}001E`);
    if (a) return new TextDecoder('windows-1252').decode(cfb.read(a)).replace(/\0+$/, '');
    return '';
  };
  const bin = id => { const e = map.get(`__substg1.0_${id}0102`); return e ? cfb.read(e) : null; };
  const time = (headerSize, ...ids) => {
    const e = map.get('__properties_version1.0');
    if (!e) return null;
    const p = cfb.read(e);
    for (const id of ids) {
      for (let off = headerSize; off + 16 <= p.length; off += 16) {
        if (p.readUInt32LE(off) === ((id << 16) | 0x0040) >>> 0) {
          const ft = p.readBigUInt64LE(off + 8);
          return new Date(Number(ft / 10000n) - 11644473600000);
        }
      }
    }
    return null;
  };
  return { map, str, bin, time };
}

export function parseMsg(buf, htmlToText) {
  const cfb = readCfb(buf);
  const p = props(cfb, cfb.root);
  const subject = p.str('0037');
  const fromName = p.str('0C1A') || p.str('0042');
  const fromAddr = p.str('5D01') || p.str('0C1F') || p.str('0065');
  const to = p.str('0E04'), cc = p.str('0E03');
  let body = p.str('1000');
  if (!body.trim()) {
    const html = p.bin('1013') || (p.str('1013') ? Buffer.from(p.str('1013')) : null);
    if (html) body = htmlToText(html.toString('utf8'));
  }
  // top-level message: 32-byte header in the property stream
  const date = p.time(32, 0x0039, 0x0E06, 0x3007);

  const attachments = cfb.children(cfb.root)
    .filter(e => e.name.startsWith('__attach_version1.0_'))
    .map(e => { const ap = props(cfb, cfb.indexOf(e)); return ap.str('3707') || ap.str('3704') || ap.str('3001'); })
    .filter(Boolean);

  const from = fromName && fromAddr && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : (fromName || fromAddr);
  const people = [fromName || fromAddr, ...to.split(';'), ...cc.split(';')].map(s => s.trim()).filter(Boolean);
  return {
    title: subject || 'Email',
    body: [from && `From: ${from}`, to && `To: ${to}`, cc && `Cc: ${cc}`,
      attachments.length ? `Attachments: ${attachments.join(', ')}` : '', '', body.replace(/\r/g, '').trim()]
      .filter((x, i) => x || i === 4).join('\n').trim(),
    people: [...new Set(people)].join(', '),
    source: 'email',
    occurred_at: date && !isNaN(date) ? date.toLocaleDateString('sv-SE') : undefined,
  };
}
