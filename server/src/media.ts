import type { IncomingMessage } from 'node:http';
import { createWriteStream, mkdirSync, openSync, readSync, closeSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { DB } from './db.ts';
import { HttpError } from './http.ts';
import { nowIso } from './auth.ts';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/** Allowed upload types. SVG/HTML are deliberately excluded (script injection). */
const TYPES: Record<string, { kind: MediaKind; ext: string; sniff: (b: Buffer) => boolean }> = {
  'image/jpeg': { kind: 'image', ext: '.jpg', sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { kind: 'image', ext: '.png', sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { kind: 'image', ext: '.webp', sniff: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  'image/gif': { kind: 'image', ext: '.gif', sniff: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
  'image/avif': { kind: 'image', ext: '.avif', sniff: (b) => b.toString('latin1', 4, 8) === 'ftyp' },
  'video/mp4': { kind: 'video', ext: '.mp4', sniff: (b) => b.toString('latin1', 4, 8) === 'ftyp' },
  'video/quicktime': { kind: 'video', ext: '.mov', sniff: (b) => ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(b.toString('latin1', 4, 8)) },
  'video/webm': { kind: 'video', ext: '.webm', sniff: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  'audio/mpeg': { kind: 'audio', ext: '.mp3', sniff: (b) => b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  'audio/mp4': { kind: 'audio', ext: '.m4a', sniff: (b) => b.toString('latin1', 4, 8) === 'ftyp' },
  'audio/x-m4a': { kind: 'audio', ext: '.m4a', sniff: (b) => b.toString('latin1', 4, 8) === 'ftyp' },
  'audio/aac': { kind: 'audio', ext: '.aac', sniff: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
  'audio/wav': { kind: 'audio', ext: '.wav', sniff: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
  'audio/x-wav': { kind: 'audio', ext: '.wav', sniff: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
  'audio/ogg': { kind: 'audio', ext: '.ogg', sniff: (b) => b.toString('latin1', 0, 4) === 'OggS' },
  'audio/flac': { kind: 'audio', ext: '.flac', sniff: (b) => b.toString('latin1', 0, 4) === 'fLaC' },
  'application/pdf': { kind: 'file', ext: '.pdf', sniff: (b) => b.toString('latin1', 0, 5) === '%PDF-' },
};

export const ACCEPT = Object.keys(TYPES);

export interface MediaRow { id: string; mime: string; kind: MediaKind; size: number; original_name: string; created_at: string }

export class MediaStore {
  dir: string;
  db: DB;
  maxBytes: number;
  constructor(db: DB, dir: string, maxBytes: number) {
    this.db = db;
    this.dir = dir;
    this.maxBytes = maxBytes;
    mkdirSync(dir, { recursive: true });
  }

  path(id: string): string | null {
    if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(id) || id.startsWith('.')) return null;
    return join(this.dir, basename(id));
  }

  exists = (id: string): boolean => !!this.db.prepare('SELECT 1 FROM media WHERE id = ?').get(id);

  get(id: string): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
  }

  async upload(req: IncomingMessage, originalName: string, opts: { maxBytes?: number; kinds?: MediaKind[] } = {}): Promise<MediaRow> {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const t = TYPES[mime];
    if (!t) throw new HttpError(415, `This file type isn't supported (${mime || 'unknown'}). Use JPG, PNG, WebP, MP4, MP3, M4A, WAV or PDF.`);
    if (opts.kinds && !opts.kinds.includes(t.kind)) throw new HttpError(415, `Please choose a ${opts.kinds.join(' or ')} file`);
    const max = Math.min(opts.maxBytes ?? this.maxBytes, this.maxBytes);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > max) throw new HttpError(413, `File is larger than ${Math.round(max / 1e6)} MB`);
    const id = `${t.kind[0]}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}${t.ext}`;
    const tmp = join(this.dir, `.${id}.part`);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) cb(new HttpError(413, `File is larger than ${Math.round(max / 1e6)} MB`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tmp));
      if (size === 0) throw new HttpError(400, 'The file is empty');
      const head = Buffer.alloc(16);
      const fd = openSync(tmp, 'r');
      readSync(fd, head, 0, 16, 0);
      closeSync(fd);
      if (!t.sniff(head)) throw new HttpError(415, "The file's contents don't match its type. Re-export it and try again.");
      renameSync(tmp, join(this.dir, id));
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'Upload was interrupted. Please try again.');
    }
    const clean = basename(originalName || 'upload').replace(/[^\w .()-]/g, '').slice(0, 120) || 'upload' + t.ext;
    const row: MediaRow = { id, mime, kind: t.kind, size, original_name: clean, created_at: nowIso() };
    this.db.prepare('INSERT INTO media (id, mime, kind, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.mime, row.kind, row.size, row.original_name, row.created_at);
    return row;
  }

  /** Register a file already on disk (used by the seeder). */
  register(id: string, originalName: string): MediaRow {
    const ext = extname(id).toLowerCase();
    const entry = Object.entries(TYPES).find(([, v]) => v.ext === ext);
    if (!entry) throw new Error('Unknown seed media type ' + id);
    const p = this.path(id)!;
    const size = statSync(p).size;
    const row: MediaRow = { id, mime: entry[0], kind: entry[1].kind, size, original_name: originalName, created_at: nowIso() };
    this.db.prepare('INSERT OR REPLACE INTO media (id, mime, kind, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.mime, row.kind, row.size, row.original_name, row.created_at);
    return row;
  }

  remove(id: string): void {
    const p = this.path(id);
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
    if (p) try { unlinkSync(p); } catch { /* already gone */ }
  }
}
