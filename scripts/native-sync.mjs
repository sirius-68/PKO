// Points the bundled app at your hosted API, then copies the web build into the
// iOS/Android projects. Usage: API_URL=https://api.example.org npm run native:sync
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const api = (process.env.API_URL || '').replace(/\/$/, '');
if (!/^https:\/\/[^/]+/.test(api)) {
  console.error('Set API_URL to your server, e.g. API_URL=https://api.yourministry.org npm run native:sync');
  console.error('(It must be https — iOS and Android block plain http by default.)');
  process.exit(1);
}
const file = 'app/config.js';
const original = readFileSync(file, 'utf8');
writeFileSync(file, original.replace(/apiBase:\s*'[^']*'/, `apiBase: '${api}'`));
try {
  for (const p of ['ios', 'android']) if (!existsSync(p)) execSync(`npx cap add ${p}`, { stdio: 'inherit' });
  execSync('npx capacitor-assets generate --iconBackgroundColor "#1E0D33" --splashBackgroundColor "#130A20" --assetPath app/icons', { stdio: 'inherit' });
  execSync('npx cap sync', { stdio: 'inherit' });
  console.log(`\nNative projects synced. The app talks to ${api}.`);
} finally {
  writeFileSync(file, original); // keep the web build same-origin
}
