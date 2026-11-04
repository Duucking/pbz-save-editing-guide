#!/usr/bin/env node
// Extract one slot's decrypted (still Oodle-compressed) payload.
// usage: node pbz_slot.js <save> <gameDir> <slotName> <outBin>
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
function openBlock(save, key, off, len) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, save.slice(off + 8, off + 20));
  d.setAuthTag(save.slice(off + 20, off + 36));
  return Buffer.concat([d.update(save.slice(off + 36, off + len)), d.final()]);
}
const [savePath, gameDir, slotName, outBin] = process.argv.slice(2);
const save = fs.readFileSync(savePath);
const count = save.readUInt16LE(6), dirSize = save.readUInt32LE(8);
const key = findKey(path.join(gameDir, 'platform/steam/PBZ.exe'), save.slice(12, 12 + dirSize));
if (!key) throw new Error('key not found');
const dir = openBlock(save, key, 12, dirSize);
const base = 12 + dirSize;
let p = 12;
for (let i = 0; i < count; i++) {
  const n = dir.readUInt16LE(p); p += 2;
  const name = dir.slice(p, p + n).toString('utf8'); p += n;
  const algo = dir[p], flag = dir[p + 1]; p += 2;
  const rawSize = dir.readUInt32LE(p); p += 4;
  const offset = dir.readUInt32LE(p); p += 4;
  const blockSize = dir.readUInt32LE(p); p += 4;
  if (name === slotName) {
    const payload = openBlock(save, key, base + offset, blockSize);
    fs.writeFileSync(outBin, payload);
    console.log(JSON.stringify({ name, algo, rawSize, blockSize, payload: payload.length }));
    process.exit(0);
  }
}
throw new Error('slot not found');
