// Youlity Shop — Stripe Checkout Session erstellen
// verify_jwt: false (öffentlicher Shop, keine User-Accounts)
// Immer HTTP 200 mit { ok, ... } — Business-Logik im Body, nicht im Statuscode.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Versandstaffelung ────────────────────────────────────────────────
// Jedes Produkt hat eine shipping_class. Für den Warenkorb gilt die
// höchste Klasse; ab 4 Artikeln geht es eine Stufe hoch.
// Beträge über Secrets überschreibbar (Werte in Cent, inkl. Verpackung).
const CLASS_ORDER = ['brief', 'paeckchen', 'paket'] as const;
type ShipClass = typeof CLASS_ORDER[number];

function shippingCents(cls: ShipClass): number {
  const envName = {
    brief: 'SHIP_BRIEF_CENTS',
    paeckchen: 'SHIP_PAECKCHEN_CENTS',
    paket: 'SHIP_PAKET_CENTS',
  }[cls];
  const fallback = { brief: 250, paeckchen: 450, paket: 650 }[cls];
  const v = parseInt(Deno.env.get(envName) || '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function resolveShipping(classes: ShipClass[], totalQty: number): number {
  let rank = 0;
  for (const c of classes) rank = Math.max(rank, CLASS_ORDER.indexOf(c));
  if (totalQty > 3) rank = Math.min(rank + 1, CLASS_ORDER.length - 1);
  return shippingCents(CLASS_ORDER[rank]);
}

// Verfügbarer Bestand für ein Produkt (null = unbegrenzt)
function availableStock(p: any, size?: string): number | null {
  if (p.sizes?.length) {
    if (!p.stock_by_size) return null; // keine Bestandsführung gesetzt
    const v = p.stock_by_size[size ?? ''];
    return v === undefined || v === null ? null : Number(v);
  }
  return p.stock === null || p.stock === undefined ? null : Number(p.stock);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' });

  const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY');
  if (!STRIPE_KEY) return json({ ok: false, error: 'stripe_not_configured' });

  const SB_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const SB_HEADERS = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  let items: { id: string; quantity: number; size?: string }[];
  try {
    const body = await req.json();
    items = body.items;
    if (!Array.isArray(items) || !items.length) throw new Error();
  } catch {
    return json({ ok: false, error: 'invalid_request' });
  }

  // Produkte serverseitig laden — Preise NIE vom Client übernehmen
  const ids = [...new Set(items.map((i) => i.id))];
  const res = await fetch(
    `${SB_URL}/rest/v1/products?id=in.(${ids.join(',')})&active=eq.true` +
      `&select=id,name,price_cents,sizes,stock,stock_by_size,shipping_class,image_url`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return json({ ok: false, error: 'db_error' });
  const products: any[] = await res.json();
  const byId = new Map(products.map((p) => [p.id, p]));

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', 'https://youlity.de/shop/?status=success');
  params.set('cancel_url', 'https://youlity.de/shop/?status=cancel');
  // Nur EU-Inland — die Schweiz braucht Zollerklärung und anderes Porto
  ['DE', 'AT'].forEach((c, i) =>
    params.set(`shipping_address_collection[allowed_countries][${i}]`, c)
  );

  const orderItems: any[] = [];
  const classes: ShipClass[] = [];
  let subtotal = 0;
  let totalQty = 0;
  let idx = 0;

  for (const item of items) {
    const p = byId.get(item.id);
    if (!p) return json({ ok: false, error: 'product_unavailable', product_id: item.id });

    const qty = Math.max(1, Math.min(20, Math.floor(item.quantity || 1)));

    if (p.sizes?.length && (!item.size || !p.sizes.includes(item.size))) {
      return json({ ok: false, error: 'size_required', product_name: p.name });
    }

    const avail = availableStock(p, item.size);
    if (avail !== null && avail < qty) {
      return json({
        ok: false,
        error: 'out_of_stock',
        product_name: p.name,
        size: item.size ?? null,
        available: avail,
      });
    }

    const label = item.size ? `${p.name} (${item.size})` : p.name;
    params.set(`line_items[${idx}][price_data][currency]`, 'eur');
    params.set(`line_items[${idx}][price_data][unit_amount]`, String(p.price_cents));
    params.set(`line_items[${idx}][price_data][product_data][name]`, label);
    if (p.image_url) {
      params.set(`line_items[${idx}][price_data][product_data][images][0]`, p.image_url);
    }
    params.set(`line_items[${idx}][quantity]`, String(qty));
    idx++;

    classes.push((p.shipping_class || 'paeckchen') as ShipClass);
    subtotal += p.price_cents * qty;
    totalQty += qty;
    orderItems.push({
      product_id: p.id,
      name: p.name,
      size: item.size ?? null,
      qty,
      unit_cents: p.price_cents,
    });
  }

  const ship = resolveShipping(classes, totalQty);
  if (ship > 0) {
    params.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(ship));
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'eur');
    params.set('shipping_options[0][shipping_rate_data][display_name]', 'Versand & Verpackung');
  }

  // Bestellung als 'pending' anlegen — der Webhook macht daraus 'paid'
  let orderId: string | null = null;
  const orderRes = await fetch(`${SB_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'pending',
      items: orderItems,
      subtotal_cents: subtotal,
      shipping_cents: ship,
      total_cents: subtotal + ship,
    }),
  });
  if (orderRes.ok) {
    const rows = await orderRes.json();
    orderId = rows?.[0]?.id ?? null;
  } else {
    console.error('order insert failed:', await orderRes.text());
  }
  if (orderId) params.set('metadata[order_id]', orderId);

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const session = await stripeRes.json();
  if (!stripeRes.ok) {
    console.error('Stripe error:', session?.error?.message);
    return json({ ok: false, error: 'stripe_error', detail: session?.error?.message });
  }

  if (orderId) {
    await fetch(`${SB_URL}/rest/v1/orders?id=eq.${orderId}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ stripe_session_id: session.id }),
    });
  }

  return json({ ok: true, url: session.url });
});
