#!/usr/bin/env node
/**
 * PBZS v3 (Phantom Blade Zero, Steam appid 4115450) container tool — read-only.
 * Verified against Steam build 26266538.
 *
 * usage: node pbz.js <PBZSaveGame.sav> [gameDir]
 * prints: header, key, slot table, block tiling check
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ANCHOR = Buffer.from('sealed but block is PLAINTEXT', 'utf16le');
const MAGIC = Buffer.from('PBZS');

function findKey(exePath, saveBuf) {
  const fd = fs.openSync(exePath, 'r');
  const size = fs.fstatSync(fd).size;
  const dirSize = saveBuf.readUInt32LE(8);
  const dirBlock = saveBuf.slice(12, 12 + dirSize);
  const tryKey = (mat) => {
    const key = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) key[i] = mat[i] ^ mat[i + 32];
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, dirBlock.slice(8, 20));
      d.setAuthTag(dirBlock.slice(20, 36));
      d.update(dirBlock.slice(36)); d.final();
      return key;
    } catch { return null; }
  };
  // 1) fast path: scan whole exe for the UTF-16LE anchor, then up to 16 bytes padding
  const CHUNK = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK + ANCHOR.length);
  for (let pos = 0; pos < size; pos += CHUNK) {
    const n = fs.readSync(fd, buf, 0, CHUNK, pos);
    let i = buf.indexOf(ANCHOR, 0);
    while (i !== -1 && i < n) {
      const at = pos + i + ANCHOR.length;
      for (let pad = 0; pad < 16; pad++) {
        const m = Buffer.alloc(64);
        fs.readSync(fd, m, 0, 64, at + pad);
        const k = tryKey(m);
        if (k) { fs.closeSync(fd); return { key: k, offset: at + pad }; }
      }
      i = buf.indexOf(ANCHOR, i + 1);
    }
  }
  fs.closeSync(fd);
  return null;
}

function openBlock(save, key, off, len) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, save.slice(off + 8, off + 20));
  d.setAuthTag(save.slice(off + 20, off + 36));
  return Buffer.concat([d.update(save.slice(off + 36, off + len)), d.final()]);
}

const savePath = process.argv[2];
const gameDir = process.argv[3] || path.resolve(path.dirname(savePath), '../../../..');
const save = fs.readFileSync(savePath);
if (save.length < 12 || !save.slice(0, 4).equals(MAGIC)) throw new Error('not a PBZS file');
const version = save[4], flags = save[5], count = save.readUInt16LE(6), directorySize = save.readUInt32LE(8);
console.log(`file=${savePath}\nsize=${save.length} version=${version} flags=${flags} slots=${count} dirSize=${directorySize} (plain ${directorySize - 36})`);

const exe = path.join(gameDir, 'platform/steam/PBZ.exe');
const found = findKey(exe, save);
if (!found) throw new Error('key not found / save directory failed GCM auth');
console.log(`key=${found.key.toString('hex')}  (material @0x${found.offset.toString(16)})`);

const dir = openBlock(save, found.key, 12, directorySize);
const base = 12 + directorySize;
let p = 12, end = 0;
for (let i = 0; i < count; i++) {
  const n = dir.readUInt16LE(p); p += 2;
  const name = dir.slice(p, p + n).toString('utf8'); p += n;
  const algo = dir[p], flag = dir[p + 1]; p += 2;
  const rawSize = dir.readUInt32LE(p); p += 4;
  const offset = dir.readUInt32LE(p); p += 4;
  const blockSize = dir.readUInt32LE(p); p += 4;
  const ok = offset === end;
  console.log(`${name.padEnd(17)} algo=${algo} flag=${flag} raw=${String(rawSize).padStart(7)} off=${String(offset).padStart(8)} abs=${String(base + offset).padStart(8)} blk=${String(blockSize).padStart(7)} ${ok ? '' : '<<TILING ERROR'}`);
  end = offset + blockSize;
}
console.log(`end=${base + end} filesize=${save.length} trailing=${save.length - base - end}`);
