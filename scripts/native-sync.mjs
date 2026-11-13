// Creates/updates the Android and iOS projects with the current web build and config.
// Usage: npm run native:sync   (needs supabase.config.json filled in)
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
const run = (c) => execSync(c, { stdio: 'inherit' });
run('node scripts/write-config.mjs');
for (const p of ['android', ...(process.platform === 'darwin' ? ['ios'] : [])]) if (!existsSync(p)) run(`npx cap add ${p}`);
run('npx capacitor-assets generate --iconBackgroundColor "#1E0D33" --splashBackgroundColor "#130A20" --assetPath app/icons');
run('npx cap sync');
