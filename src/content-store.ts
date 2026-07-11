import { openSync, readSync, writeSync, closeSync, statSync } from "node:fs";

const MAGIC = "PICDB01\n";
const HEADER_SIZE = 16;
const FLAG_TOMBSTONE = 1;

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface EntryIndex {
  offset: number;
  idLen: number;
  contentLength: number;
  flags: number;
}

export class ContentStore {
  private path: string;
  private entries = new Map<number, EntryIndex>();
  private fd: number;
  private dirty = false;

  constructor(dbPath: string) {
    this.path = dbPath;
    this.fd = openSync(this.path, "a+");
    this._buildIndex();
  }

  private _buildIndex(): void {
    const stat = statSync(this.path);
    if (stat.size === 0) return;

    const buf = Buffer.alloc(stat.size);
    readSync(this.fd, buf, 0, stat.size, 0);

    let offset = 0;
    while (offset < buf.length) {
      if (buf.length - offset < 11) break;
      const hash = buf.readUInt32LE(offset);
      const idLen = buf.readUInt16LE(offset + 4);
      const contentLen = buf.readUInt32LE(offset + 6);
      const flags = buf.readUInt8(offset + 10);
      const entryStart = offset;
      const totalLen = 11 + idLen + contentLen;
      if (buf.length - offset < totalLen) break;

      if ((flags & FLAG_TOMBSTONE) === 0) {
        this.entries.set(hash, { offset: entryStart, idLen, contentLength: contentLen, flags });
      } else {
        this.entries.delete(hash);
      }
      offset += totalLen;
    }
  }

  has(id: string): boolean {
    return this.entries.has(fnv1a32(id));
  }

  read(id: string): string | null {
    const hash = fnv1a32(id);
    const entry = this.entries.get(hash);
    if (!entry) return null;

    const totalLen = 11 + entry.idLen + entry.contentLength;
    const buf = Buffer.alloc(totalLen);
    const bytesRead = readSync(this.fd, buf, 0, totalLen, entry.offset);
    if (bytesRead < totalLen) return null;

    const contentStart = 11 + entry.idLen;
    return buf.toString("utf8", contentStart, contentStart + entry.contentLength);
  }

  append(id: string, content: string, flags = 0): void {
    const hash = fnv1a32(id);
    const idBuf = Buffer.from(id, "utf8");
    const contentBuf = Buffer.from(content, "utf8");
    const entryBuf = Buffer.alloc(11 + idBuf.length + contentBuf.length);

    entryBuf.writeUInt32LE(hash, 0);
    entryBuf.writeUInt16LE(idBuf.length, 4);
    entryBuf.writeUInt32LE(contentBuf.length, 6);
    entryBuf.writeUInt8(flags, 10);
    idBuf.copy(entryBuf, 11);
    contentBuf.copy(entryBuf, 11 + idBuf.length);

    const offset = statSync(this.path).size;
    writeSync(this.fd, entryBuf, 0, entryBuf.length, offset);

    if ((flags & FLAG_TOMBSTONE) === 0) {
      this.entries.set(hash, { offset, idLen: idBuf.length, contentLength: contentBuf.length, flags });
    } else {
      this.entries.delete(hash);
    }
    this.dirty = true;
  }

  delete(id: string): void {
    this.append(id, "", FLAG_TOMBSTONE);
  }

  compact(): { before: number; after: number } {
    const before = this.entries.size;

    const buffers: Buffer[] = [];
    for (const entry of this.entries.values()) {
      if (entry.flags & FLAG_TOMBSTONE) continue;
      const totalLen = 11 + entry.idLen + entry.contentLength;
      const readBuf = Buffer.alloc(totalLen);
      const bytes = readSync(this.fd, readBuf, 0, totalLen, entry.offset);
      if (bytes === totalLen) buffers.push(readBuf);
    }

    // close, rebuild file in-place
    closeSync(this.fd);
    const newFd = openSync(this.path, "w");
    for (const buf of buffers) writeSync(newFd, buf, 0, buf.length);
    closeSync(newFd);

    this.fd = openSync(this.path, "a+");
    this.entries.clear();
    this._buildIndex();
    this.dirty = false;

    return { before, after: this.entries.size };
  }

  get size(): number {
    return this.entries.size;
  }

  close(): void {
    closeSync(this.fd);
  }
}
