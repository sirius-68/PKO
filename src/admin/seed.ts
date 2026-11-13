/**
 * One-click "Import starter content": uploads the bundled photos/videos to
 * Supabase Storage and creates the original app's posts, books, albums, events,
 * testimonies, photos and schedule. Safe to re-run: files are upserted, and the
 * button only appears while the app has no content.
 */
import { supa } from './backend.js';

interface SeedFile { media: { file: string; mime: string }[]; settings: Record<string, unknown>; live: Record<string, unknown>; items: { collection: string; hoursAgo: number; data: Record<string, unknown> }[] }

export async function importStarterContent(onProgress: (done: number, total: number, label: string) => void): Promise<number> {
  const base = new URL('seed/', location.href);
  const res = await fetch(new URL('content.json', base));
  if (!res.ok) throw new Error("Couldn't load the starter content file");
  const seed = (await res.json()) as SeedFile;
  const total = seed.media.length + seed.items.length + 2;
  let done = 0;
  const files = new Set(seed.media.map((m) => m.file));
  const ref = (v: unknown): unknown =>
    typeof v === 'string' && files.has(v) ? `seed/${v}` : Array.isArray(v) ? v.map(ref) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ref(x)])) : v;

  // Upload media (a few at a time).
  const queue = [...seed.media];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const blob = await (await fetch(new URL(`media/${m.file}`, base))).blob();
      await supa.upload(`seed/${m.file}`, blob, () => {}, { upsert: true, contentType: m.mime });
      await supa.rpc('admin_register_media', { p_id: `seed/${m.file}`, p_mime: m.mime, p_size: blob.size, p_name: m.file });
      onProgress(++done, total, `Uploading ${m.file}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  await supa.rpc('admin_save_settings', { p: ref(seed.settings) });
  onProgress(++done, total, 'Settings');
  await supa.rpc('admin_save_live', { p: ref(seed.live) });
  onProgress(++done, total, 'Live stream');
  for (const it of seed.items) {
    await supa.rpc('admin_save', {
      p_collection: it.collection, p_id: null, p_data: ref(it.data), p_status: 'published',
      p_published_at: new Date(Date.now() - it.hoursAgo * 3600e3).toISOString(),
    });
    onProgress(++done, total, `Creating ${it.collection}`);
  }
  return seed.items.length;
}
