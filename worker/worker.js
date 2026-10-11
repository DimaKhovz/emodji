// Cloudflare Worker: keeps the Gemini API key on the server.
// The app sends requests here with an access code; the worker adds the real key and forwards to Google.
//
// Secrets to set in Cloudflare (Settings → Variables and Secrets → Add → type "Secret"):
//   GEMINI_API_KEY   your Gemini API key
//   ACCESS_CODE      the code you give to friends (change it any time to cut everyone off)

const ALLOWED_ORIGINS = [
  'https://dimakhovz.github.io',
  'http://localhost:8765', // local testing
];
const MAX_BODY_CHARS = 60000;       // the biggest legit request is a few KB
const LIMIT_PER_MIN = 40;           // per visitor (best effort, per Cloudflare location)
const hits = new Map();

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-access-code',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...(origin ? cors(origin) : {}) },
  });
}

function sameCode(a, b) { // constant-time compare
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
  return list.length > LIMIT_PER_MIN;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);

    if (request.method === 'OPTIONS') {
      return allowed ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    }
    if (!allowed) return json(403, { error: { message: 'Forbidden origin' } });
    if (request.method !== 'POST') return json(405, { error: { message: 'POST only' } }, origin);

    // only Gemini text/audio generation, only gemini-* models
    const m = new URL(request.url).pathname.match(/^\/v1beta\/models\/(gemini-[a-z0-9.\-]+):generateContent$/);
    if (!m) return json(404, { error: { message: 'Not found' } }, origin);

    // fail closed: no ACCESS_CODE configured → nobody gets in
    const expected = env.ACCESS_CODE || '';
    const given = request.headers.get('x-access-code') || '';
    if (!expected || !sameCode(given, expected)) return json(401, { error: { message: 'Wrong access code' } }, origin);

    if (tooMany(request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return json(429, { error: { message: 'Too many requests, slow down a little' } }, origin);
    }

    const body = await request.text();
    if (body.length > MAX_BODY_CHARS) return json(413, { error: { message: 'Request too large' } }, origin);

    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m[1]}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', ...cors(origin) },
    });
  },
};
