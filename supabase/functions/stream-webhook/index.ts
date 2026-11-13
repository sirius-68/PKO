// Supabase Edge Function entry point (Deno). Deploy: supabase functions deploy stream-webhook --no-verify-jwt
// The streaming service calls this without a Supabase login, so JWT checks are off;
// every caller is verified by its own webhook signature or secret instead (see handler.ts).
import { handle, type Env, type StreamEvent } from './handler.ts';

declare const Deno: { env: { get(k: string): string | undefined; toObject(): Record<string, string> }; serve(h: (r: Request) => Promise<Response>): void };

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // provided by Supabase inside Edge Functions; never leaves the server

async function ingest(ev: StreamEvent): Promise<unknown> {
  const r = await fetch(`${url}/rest/v1/rpc/stream_ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ p: ev }),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`stream_ingest failed (${r.status}): ${JSON.stringify(out)}`);
  return out;
}

Deno.serve((req) => handle(req, Deno.env.toObject() as Env, ingest).catch((e) => {
  console.error(e);
  return new Response(JSON.stringify({ error: 'Could not record the event' }), { status: 500, headers: { 'content-type': 'application/json' } });
}));
