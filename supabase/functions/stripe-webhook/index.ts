// Youlity Shop — Stripe Webhook
// verify_jwt: false — Stripe schickt keinen JWT. Die Authentifizierung
// läuft über die Stripe-Signatur (STRIPE_WEBHOOK_SECRET).
//
// Bei checkout.session.completed:
//   1. Bestellung von 'pending' auf 'paid' setzen (idempotent)
//   2. Nur wenn das tatsächlich eine Zeile verändert hat: Bestand reduzieren

const TOLERANCE_SECONDS = 300;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Konstantzeit-Vergleich — verhindert Timing-Angriffe auf die Signatur
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(
  raw: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts['t'];
  if (!t) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = hex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)),
  );

  // Stripe darf mehrere v1-Signaturen schicken (Secret-Rotation)
  return header
    .split(',')
    .filter((kv) => kv.trim().startsWith('v1='))
    .some((kv) => safeEqual(kv.trim().slice(3), sig));
}

Deno.serve(async (req: Request) => {
  const SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET fehlt');
    return new Response('not configured', { status: 500 });
  }

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('stripe-signature'), SECRET))) {
    console.error('Signatur ungültig');
    return new Response('invalid signature', { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('bad payload', { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }

  const session = event.data?.object ?? {};
  if (session.payment_status !== 'paid') {
    return new Response('not paid', { status: 200 });
  }

  const SB_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const SB_HEADERS = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  const details = session.customer_details ?? {};
  const shipping = session.collected_information?.shipping_details
    ?? session.shipping_details
    ?? null;

  const patch = {
    status: 'paid',
    paid_at: new Date().toISOString(),
    email: details.email ?? null,
    customer_name: shipping?.name ?? details.name ?? null,
    shipping_address: shipping?.address ?? details.address ?? null,
    total_cents: session.amount_total ?? null,
    stripe_session_id: session.id,
  };

  const orderId = session.metadata?.order_id;

  // Fallback: Zahlung ohne verknüpfte Bestellung — Zeile anlegen, damit
  // kein Verkauf unbemerkt bleibt. Bestand wird hier nicht angefasst.
  if (!orderId) {
    console.error('order_id fehlt in metadata, session:', session.id);
    await fetch(`${SB_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        ...patch,
        items: [],
        note: 'Ohne order_id eingegangen — Positionen bitte im Stripe-Dashboard prüfen.',
      }),
    });
    return new Response('ok (fallback)', { status: 200 });
  }

  // Nur pending → paid. Ist die Zeile schon bezahlt, kommt [] zurück und
  // der Bestand wird nicht ein zweites Mal reduziert (Stripe wiederholt
  // Webhooks bei Timeouts).
  const upd = await fetch(
    `${SB_URL}/rest/v1/orders?id=eq.${orderId}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    },
  );
  if (!upd.ok) {
    console.error('orders update failed:', await upd.text());
    return new Response('db error', { status: 500 }); // Stripe wiederholt
  }
  const rows = await upd.json();
  if (!rows.length) {
    return new Response('ok (already processed)', { status: 200 });
  }

  const stockRes = await fetch(`${SB_URL}/rest/v1/rpc/decrement_stock`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ p_items: rows[0].items }),
  });
  if (!stockRes.ok) {
    console.error('decrement_stock failed:', await stockRes.text());
  }

  return new Response('ok', { status: 200 });
});
