// Vercel serverless function — proxies content generation to DeepSeek
// so the demo works for visitors without them entering an API key.
// Set DEEPSEEK_API_KEY in Vercel -> Project -> Settings -> Environment Variables.
//
// Best-effort rate limiting (per-IP, in-memory) to protect the owner's key.
// NOTE: in-memory state resets on cold start. For hard limits, use Vercel WAF
// (dashboard -> Firewall) or an Upstash Redis counter.

const RATE_LIMIT = 20;            // max requests per window per IP
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const COOLDOWN_MS = 3000;         // min gap between requests per IP (ms)
const MAX_INPUT_CHARS = 8000;     // reject oversized prompts

const hits = new Map(); // ip -> { count, windowStart, lastAt }

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    rec = { count: 0, windowStart: now, lastAt: 0 };
    hits.set(ip, rec);
  }
  if (now - rec.lastAt < COOLDOWN_MS) return true; // too fast
  if (rec.count >= RATE_LIMIT) return true;        // window exhausted
  rec.count++;
  rec.lastAt = now;
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.windowStart > WINDOW_MS) hits.delete(k);
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return res.status(500).json({ error: 'DeepSeek key not configured on the server' });

  const ip = clientIP(req);
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });

  const { messages, temperature } = req.body || {};
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Missing messages' });
  if (JSON.stringify(messages).length > MAX_INPUT_CHARS) return res.status(400).json({ error: 'Input too long' });

  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: temperature ?? 0.8 })
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error: ' + e.message });
  }
}
