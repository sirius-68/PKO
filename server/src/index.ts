import { createApp, defaultConfig } from './app.ts';
import { seed } from './seed.ts';

const cfg = defaultConfig();
const app = createApp(cfg);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

const { seeded, adminCreated } = seed(app.deps, {
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  adminName: process.env.ADMIN_NAME,
});
if (seeded) console.log('Seeded starter content.');
if (adminCreated) console.log(`Created dashboard account for ${process.env.ADMIN_EMAIL}.`);
const admins = (app.deps.db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n;
if (!admins) console.warn('No dashboard account yet. Restart with ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) set to create one.');

app.server.listen(port, host, () => {
  console.log(`PKO server on http://localhost:${port}  — app: /app/  dashboard: /admin/`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log('Shutting down…'); app.close().then(() => process.exit(0)); });
}
