// Copies the starter content and media into app/demo/ for a demo build (no backend).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const root = new URL('../', import.meta.url);
rmSync(new URL('app/demo', root), { recursive: true, force: true });
mkdirSync(new URL('app/demo', root), { recursive: true });
cpSync(new URL('admin/seed/content.json', root), new URL('app/demo/content.json', root));
cpSync(new URL('admin/seed/media', root), new URL('app/demo/media', root), { recursive: true });
console.log('Demo content copied to app/demo/');
