/**
 * Content schema — the single source of truth for every content type.
 * The API validates against it and the creator dashboard builds its forms from it
 * (served at GET /api/admin/schema), so adding a field here adds it everywhere.
 */

export type FieldType =
  | 'text' | 'longtext' | 'paragraphs' | 'number' | 'date' | 'datetime'
  | 'select' | 'image' | 'video' | 'audio' | 'file' | 'bool' | 'position' | 'list';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];          // select
  allowCustom?: boolean;       // select: free text allowed (e.g. gallery album names)
  help?: string;
  max?: number;                // max length (text) or max value (number)
  min?: number;
  default?: unknown;
  fields?: Field[];            // list: shape of each row
  listLabel?: string;          // list: singular row label
}

export interface Collection {
  key: string;
  label: string;               // plural, shown in the dashboard nav
  singular: string;
  icon: string;
  titleField: string;
  imageField?: string;
  /** Members can create items here (pending moderation). */
  moderated?: boolean;
  fields: Field[];
  sort: 'published_desc' | 'date_asc' | 'manual';
}

const POS_HELP = 'Which part of the photo stays visible when cropped, e.g. "center 30%".';

export const COLLECTIONS: Collection[] = [
  {
    key: 'posts', label: 'Blog posts', singular: 'Blog post', icon: 'pen', titleField: 'title', imageField: 'image',
    sort: 'published_desc',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, max: 140 },
      { key: 'flair', label: 'Category', type: 'select', options: ['Morning Word', 'Teaching', 'Prophetic'], allowCustom: true, required: true },
      { key: 'verse', label: 'Key verse', type: 'longtext', max: 600 },
      { key: 'ref', label: 'Scripture reference', type: 'text', max: 60, help: 'e.g. Matthew 17:2' },
      { key: 'body', label: 'Body', type: 'paragraphs', required: true, help: 'Leave a blank line between paragraphs.' },
      { key: 'image', label: 'Cover photo', type: 'image' },
      { key: 'imagePos', label: 'Photo focus', type: 'position', default: 'center', help: POS_HELP },
    ],
  },
  {
    key: 'broadcasts', label: 'TV broadcasts', singular: 'Broadcast', icon: 'tv', titleField: 'title', imageField: 'poster',
    sort: 'published_desc',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, max: 140 },
      { key: 'ref', label: 'Scripture or subtitle', type: 'text', max: 80 },
      { key: 'category', label: 'Category', type: 'select', options: ['Teachings', 'Ministration', 'Crusades', 'Services'], allowCustom: true, required: true },
      { key: 'video', label: 'Video file', type: 'video', help: 'MP4 (H.264) plays everywhere.' },
      { key: 'url', label: '…or video URL', type: 'text', max: 600, help: 'An MP4 or HLS (.m3u8) link, used when no file is uploaded.' },
      { key: 'poster', label: 'Thumbnail', type: 'image', required: true },
    ],
  },
  {
    key: 'books', label: 'Books', singular: 'Book', icon: 'book', titleField: 'title', imageField: 'image',
    sort: 'manual',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, max: 140 },
      { key: 'description', label: 'Description', type: 'longtext', required: true, max: 2000 },
      { key: 'year', label: 'Year published', type: 'number', min: 1900, max: 2100 },
      { key: 'pages', label: 'Pages', type: 'number', min: 1, max: 5000 },
      { key: 'image', label: 'Cover photo', type: 'image', required: true },
      { key: 'imagePos', label: 'Photo focus', type: 'position', default: 'center', help: POS_HELP },
      { key: 'pdf', label: 'PDF edition', type: 'file', help: 'Optional. Readers can open the full PDF.' },
      { key: 'chapters', label: 'Chapters', type: 'list', listLabel: 'Chapter', fields: [
        { key: 'title', label: 'Chapter title', type: 'text', required: true, max: 140 },
        { key: 'body', label: 'Text', type: 'paragraphs', required: true },
      ] },
    ],
  },
  {
    key: 'albums', label: 'Albums', singular: 'Album', icon: 'music', titleField: 'title', imageField: 'image',
    sort: 'published_desc',
    fields: [
      { key: 'title', label: 'Album title', type: 'text', required: true, max: 140 },
      { key: 'artist', label: 'Artist', type: 'text', required: true, max: 120, default: 'Transfiguration Choir' },
      { key: 'year', label: 'Year', type: 'number', min: 1900, max: 2100 },
      { key: 'image', label: 'Album cover', type: 'image', required: true },
      { key: 'imagePos', label: 'Photo focus', type: 'position', default: 'center', help: POS_HELP },
      { key: 'tracks', label: 'Tracks', type: 'list', listLabel: 'Track', fields: [
        { key: 'title', label: 'Song title', type: 'text', required: true, max: 140 },
        { key: 'audio', label: 'Audio file', type: 'audio' },
        { key: 'duration', label: 'Length (seconds)', type: 'number', min: 0, max: 36000, help: 'Filled automatically when you upload audio.' },
      ] },
    ],
  },
  {
    key: 'events', label: 'Events', singular: 'Event', icon: 'cal', titleField: 'title', imageField: 'image',
    sort: 'date_asc',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, max: 140 },
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'time', label: 'Time', type: 'text', required: true, max: 60, help: 'e.g. 21:00 – 04:00' },
      { key: 'place', label: 'Place', type: 'text', required: true, max: 140 },
      { key: 'description', label: 'Description', type: 'longtext', required: true, max: 2000 },
      { key: 'image', label: 'Photo', type: 'image' },
      { key: 'imagePos', label: 'Photo focus', type: 'position', default: 'center', help: POS_HELP },
    ],
  },
  {
    key: 'testimonies', label: 'Testimonies', singular: 'Testimony', icon: 'quote', titleField: 'title', moderated: true,
    sort: 'published_desc',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, max: 140 },
      { key: 'name', label: 'Name shown', type: 'text', required: true, max: 80 },
      { key: 'place', label: 'City', type: 'text', max: 80 },
      { key: 'quote', label: 'Pull quote', type: 'longtext', max: 300, help: 'One sentence shown on the card.' },
      { key: 'body', label: 'Story', type: 'paragraphs', required: true },
      { key: 'video', label: 'Video', type: 'video' },
    ],
  },
  {
    key: 'photos', label: 'Gallery', singular: 'Photo', icon: 'image', titleField: 'caption', imageField: 'image',
    sort: 'published_desc',
    fields: [
      { key: 'image', label: 'Photo', type: 'image', required: true },
      { key: 'caption', label: 'Caption', type: 'text', required: true, max: 140 },
      { key: 'album', label: 'Album', type: 'select', options: ['Services', 'Crusade nights', 'Portraits'], allowCustom: true, required: true },
    ],
  },
  {
    key: 'schedule', label: 'TV schedule', singular: 'Schedule slot', icon: 'clock', titleField: 'title',
    sort: 'manual',
    fields: [
      { key: 'time', label: 'Time', type: 'text', required: true, max: 10, help: '24-hour time, e.g. 18:30' },
      { key: 'title', label: 'Programme', type: 'text', required: true, max: 140 },
      { key: 'subtitle', label: 'Subtitle', type: 'text', max: 140 },
    ],
  },
];

export const COLLECTION_MAP = new Map(COLLECTIONS.map((c) => [c.key, c]));

/** App-wide settings, edited on the dashboard's Settings and Live pages. */
export const SETTINGS_FIELDS: Field[] = [
  { key: 'appName', label: 'App name', type: 'text', required: true, max: 60 },
  { key: 'ministry', label: 'Ministry name', type: 'text', required: true, max: 80 },
  { key: 'tvName', label: 'TV channel name', type: 'text', required: true, max: 60 },
  { key: 'recordsName', label: 'Record label name', type: 'text', required: true, max: 60 },
  { key: 'leader', label: 'Leader name', type: 'text', required: true, max: 60 },
  { key: 'aboutText', label: 'About text', type: 'longtext', max: 600 },
  { key: 'aboutVerse', label: 'About verse', type: 'longtext', max: 800 },
  { key: 'aboutVerseRef', label: 'About verse reference', type: 'text', max: 60 },
  { key: 'logo', label: 'Logo', type: 'image' },
  { key: 'leaderPhoto', label: 'Leader photo (blog byline)', type: 'image' },
];

export const LIVE_FIELDS: Field[] = [
  { key: 'onAir', label: 'On air now', type: 'bool', default: false },
  { key: 'title', label: 'Service title', type: 'text', required: true, max: 140 },
  { key: 'ref', label: 'Scripture or subtitle', type: 'text', max: 80 },
  { key: 'video', label: 'Stream file', type: 'video', help: 'Loops while on air. Use a URL below for a real live feed.' },
  { key: 'url', label: '…or stream URL', type: 'text', max: 600, help: 'HLS (.m3u8) or MP4. HLS plays natively on iOS, Android and Safari.' },
  { key: 'poster', label: 'Poster image', type: 'image', required: true },
];

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidationResult { ok: boolean; data: Record<string, unknown>; errors: Record<string, string> }

/** Validate & normalise input against a field list. Unknown keys are dropped. */
export function validate(fields: Field[], input: unknown, opts: { partial?: boolean; mediaExists?: (id: string) => boolean } = {}): ValidationResult {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    let v = src[f.key];
    if (v === undefined) {
      if (opts.partial) continue;
      v = f.default;
    }
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errors[f.key] = `${f.label} is required`;
      else data[f.key] = f.type === 'list' ? [] : f.type === 'bool' ? false : null;
      continue;
    }
    switch (f.type) {
      case 'text': case 'longtext': case 'position': case 'select': {
        if (typeof v !== 'string') { errors[f.key] = `${f.label} must be text`; break; }
        const s = v.trim();
        if (f.max && s.length > f.max) { errors[f.key] = `${f.label} must be ${f.max} characters or fewer`; break; }
        if (f.type === 'select' && !f.allowCustom && f.options && !f.options.includes(s)) { errors[f.key] = `${f.label} must be one of ${f.options.join(', ')}`; break; }
        if (f.type === 'position' && !/^[a-z0-9 %.-]{1,40}$/i.test(s)) { errors[f.key] = `${f.label} looks invalid`; break; }
        if (f.required && !s) { errors[f.key] = `${f.label} is required`; break; }
        data[f.key] = s;
        break;
      }
      case 'paragraphs': {
        const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n\s*\n/) : null;
        if (!arr || arr.some((p) => typeof p !== 'string')) { errors[f.key] = `${f.label} must be text`; break; }
        const paras = (arr as string[]).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
        if (f.required && !paras.length) { errors[f.key] = `${f.label} is required`; break; }
        if (paras.join('').length > 200_000) { errors[f.key] = `${f.label} is too long`; break; }
        data[f.key] = paras;
        break;
      }
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(n)) { errors[f.key] = `${f.label} must be a number`; break; }
        if (f.min !== undefined && n < f.min) { errors[f.key] = `${f.label} must be at least ${f.min}`; break; }
        if (f.max !== undefined && n > f.max) { errors[f.key] = `${f.label} must be at most ${f.max}`; break; }
        data[f.key] = n;
        break;
      }
      case 'date': {
        if (typeof v !== 'string' || !ISO_DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) { errors[f.key] = `${f.label} must be a date (YYYY-MM-DD)`; break; }
        data[f.key] = v;
        break;
      }
      case 'datetime': {
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) { errors[f.key] = `${f.label} must be a date and time`; break; }
        data[f.key] = new Date(v).toISOString();
        break;
      }
      case 'bool': data[f.key] = v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; break;
      case 'image': case 'video': case 'audio': case 'file': {
        if (typeof v !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(v) || v.includes('..')) { errors[f.key] = `${f.label} is not a valid upload`; break; }
        if (opts.mediaExists && !opts.mediaExists(v)) { errors[f.key] = `${f.label} file was not found — upload it again`; break; }
        data[f.key] = v;
        break;
      }
      case 'list': {
        if (!Array.isArray(v)) { errors[f.key] = `${f.label} must be a list`; break; }
        if (v.length > 500) { errors[f.key] = `${f.label} has too many rows`; break; }
        const rows: Record<string, unknown>[] = [];
        v.forEach((row, i) => {
          const r = validate(f.fields || [], row, { mediaExists: opts.mediaExists });
          if (!r.ok) for (const [k, msg] of Object.entries(r.errors)) errors[`${f.key}.${i}.${k}`] = `${f.listLabel || 'Row'} ${i + 1}: ${msg}`;
          const id = (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string' && /^[a-z0-9-]{1,40}$/i.test((row as { id: string }).id)) ? (row as { id: string }).id : null;
          rows.push({ id: id || `${f.key.slice(0, 2)}${i}-${Math.random().toString(36).slice(2, 8)}`, ...r.data });
        });
        data[f.key] = rows;
        break;
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, data, errors };
}

/** Every media id referenced by a record (walks list rows too). */
export function mediaRefs(fields: Field[], data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const v = data[f.key];
    if (MEDIA_TYPES.has(f.type) && typeof v === 'string' && v) out.push(v);
    if (f.type === 'list' && Array.isArray(v)) for (const row of v) out.push(...mediaRefs(f.fields || [], row as Record<string, unknown>));
  }
  return out;
}
