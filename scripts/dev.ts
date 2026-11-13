// Local development without a Supabase account: a fresh Postgres database with the
// real migration, the local Supabase emulator, and the app + dashboard served from it.
// Needs a local Postgres with trust auth (PGHOST/PGPORT/PGUSER).
import { startTestServer, ADMIN } from '../tests/helpers.ts';
const s = await startTestServer();
console.log(`\n  App:        ${s.base}/app/\n  Dashboard:  ${s.base}/admin/  (${ADMIN.email} / ${ADMIN.password})\n\n  Ctrl+C to stop (the throwaway database is dropped).`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => s.close().then(() => process.exit(0)));
