#!/usr/bin/env node
/**
 * PBZS v3 repacker.
 * usage: node pbz_repack.js <save> <gameDir> <spec.json> <out.sav>
 * spec.json = { "slots": { "AutoSave0": "path/to/new.json" } }
 * Replacement slots are Oodle "stored" blocks (algo stays 2):
 *   0xCC 0x06 + 0x40000-byte chunks
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ANCHOR = Buffer.from('sealed but block is PLAINTEXT', 'utf16le');

function findKey(exePath, dirBlock) {
  const fd = fs.openSync(exePath, 'r');
  const size = fs.fstatSync(fd).size;
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
        if (k) { fs.closeSync(fd); return k; }
      }
      i = buf.indexOf(ANCHOR, i + 1);
    }
  }
  fs.closeSync(fd);
  return null;
}

function decryptBlock(save, key, off, len) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, save.slice(off + 8, off + 20));
  d.setAuthTag(save.slice(off + 20, off + 36));
  return Buffer.concat([d.update(save.slice(off + 36, off + len)), d.final()]);
}

function encryptBlock(key, plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([Buffer.from('PBZS\x01\x01\x00\x00', 'latin1'), nonce, tag, ct]);
}

function storedOodle(data) {
  const parts = [];
  for (let p = 0; p < data.length; p += 0x40000) {
    parts.push(Buffer.from([0xcc, 0x06]), data.slice(p, p + 0x40000));
  }
  return Buffer.concat(parts);
}

const savePath = process.argv[2];
const gameDir = process.argv[3];
const specPath = process.argv[4];
const outPath = process.argv[5];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
const save = fs.readFileSync(savePath);
const count = save.readUInt16LE(6), dirSize = save.readUInt32LE(8);
const key = findKey(path.join(gameDir, 'platform/steam/PBZ.exe'), save.slice(12, 12 + dirSize));
if (!key) throw new Error('key not found');
const dir = decryptBlock(save, key, 12, dirSize);
const base = 12 + dirSize;
const oldTable = [];
let p = 12;
for (let i = 0; i < count; i++) {
  const n = dir.readUInt16LE(p); p += 2;
  const name = dir.slice(p, p + n).toString('utf8'); p += n;
  const algo = dir[p], flag = dir[p + 1]; p += 2;
  const rawSize = dir.readUInt32LE(p); p += 4;
  const offset = dir.readUInt32LE(p); p += 4;
  const blockSize = dir.readUInt32LE(p); p += 4;
  oldTable.push({ name, algo, flag, rawSize, offset, blockSize });
}

const blocks = [];
for (const e of oldTable) {
  const abs = base + e.offset;
  if (Object.prototype.hasOwnProperty.call(spec.slots || {}, e.name)) {
    const raw = fs.readFileSync(spec.slots[e.name]);
    const payload = storedOodle(raw);
    blocks.push({ ...e, rawSize: raw.length, payload, changed: true });
    console.log(`${e.name}: replaced raw=${raw.length} payload=${payload.length}`);
  } else {
    const payload = decryptBlock(save, key, abs, e.blockSize);
    blocks.push({ ...e, payload, changed: false });
  }
}

// rebuild directory
const records = [];
let off = 0;
for (const b of blocks) {
  const nameBuf = Buffer.from(b.name, 'utf8');
  const r = Buffer.alloc(2 + nameBuf.length + 2 + 12);
  let q = 0;
  r.writeUInt16LE(nameBuf.length, q); q += 2;
  nameBuf.copy(r, q); q += nameBuf.length;
  r[q] = b.algo; r[q + 1] = b.flag; q += 2;
  r.writeUInt32LE(b.rawSize, q); q += 4;
  r.writeUInt32LE(off, q); q += 4;
  r.writeUInt32LE(36 + b.payload.length, q); q += 4;
  records.push(r);
  b.newOffset = off;
  off += 36 + b.payload.length;
}
const headerPlain = Buffer.alloc(12);
Buffer.from('PBZS', 'latin1').copy(headerPlain, 0);
headerPlain[4] = 3; headerPlain[5] = 1;
headerPlain.writeUInt16LE(count, 6);
const dirPlain = Buffer.concat([headerPlain, ...records]);
dirPlain.writeUInt32LE(36 + dirPlain.length, 8); // 含 36 字节块头的目录块总长
const dirBlockFinal = encryptBlock(key, dirPlain);
const out = Buffer.alloc(12);
Buffer.from('PBZS', 'latin1').copy(out, 0);
out[4] = 3; out[5] = 1;
out.writeUInt16LE(count, 6);
out.writeUInt32LE(dirBlockFinal.length, 8);
const parts = [out, dirBlockFinal];
for (const b of blocks) parts.push(encryptBlock(key, b.payload));
const result = Buffer.concat(parts);
fs.writeFileSync(outPath, result);
console.log(`wrote ${outPath} size=${result.length} dirBlock=${dirBlockFinal.length}`);
