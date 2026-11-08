// Export des planches sans bibliothèque ni service externe : PDF (pages JPEG en DCTDecode) et CBZ (ZIP « stocké »,
// lisible par les liseuses de BD). Module pur, testé unitairement.

const ascii = (s: string) => new TextEncoder().encode(s);

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Lit la taille d'un JPEG (marqueur SOFn). */
export function jpegSize(data: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const m = data[i + 1];
    const len = (data[i + 2] << 8) | data[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (data[i + 5] << 8) | data[i + 6], width: (data[i + 7] << 8) | data[i + 8] };
    }
    i += 2 + len;
  }
  throw new Error('JPEG invalide');
}

/** PDF A4, une planche JPEG par page. */
export function buildPdf(pages: Uint8Array[], title = 'BD'): Uint8Array<ArrayBuffer> {
  const W = 595.28;
  const H = 841.89;
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (p: Uint8Array) => {
    parts.push(p);
    pos += p.length;
  };
  const obj = (n: number, body: Uint8Array[]) => {
    offsets[n] = pos;
    push(ascii(`${n} 0 obj\n`));
    for (const b of body) push(b);
    push(ascii('\nendobj\n'));
  };
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + octets binaires
  const n = pages.length;
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, [ascii('<< /Type /Catalog /Pages 2 0 R >>')]);
  obj(2, [ascii(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`)]);
  const safeTitle = title.replace(/[()\\]/g, '').replace(/[^\x20-\x7e]/g, '?');
  obj(3, [ascii(`<< /Title (${safeTitle}) /Producer (Videogen) >>`)]);
  pages.forEach((jpeg, i) => {
    const pageN = 4 + i * 3;
    const { width, height } = jpegSize(jpeg);
    const content = ascii(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`);
    obj(pageN, [ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${pageN + 2} 0 R >> >> /Contents ${pageN + 1} 0 R >>`)]);
    obj(pageN + 1, [ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii('\nendstream')]);
    obj(pageN + 2, [
      ascii(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      ascii('\nendstream'),
    ]);
  });
  const total = 4 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  push(ascii(`${x}trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return concat(parts);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archive ZIP sans compression (méthode 0) : format CBZ. */
export function buildZip(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

export function comicInfoXml(title: string, pages: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n  <Title>${esc(title)}</Title>\n  <PageCount>${pages}</PageCount>\n  <LanguageISO>fr</LanguageISO>\n</ComicInfo>\n`;
}

export function buildCbz(pages: Uint8Array[], title: string): Uint8Array<ArrayBuffer> {
  return buildZip([
    ...pages.map((data, i) => ({ name: `page${String(i + 1).padStart(3, '0')}.jpg`, data })),
    { name: 'ComicInfo.xml', data: new TextEncoder().encode(comicInfoXml(title, pages.length)) },
  ]);
}
