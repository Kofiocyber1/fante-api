const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3747;
const VERSION = '2.0.0';

// ── Supabase (API key storage) ────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hpzqtolrcuehfnqkbole.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_bdFQ5vvUyBPrh9zCHNx8ZA_YdPzw42m';

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase RPC ${fn} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // behind Render's proxy
app.use(helmet({ contentSecurityPolicy: false })); // landing page uses inline styles/scripts
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120, // 120 req/min per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Limit is 120/minute.' },
});
const keygenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10, // 10 new keys/hour per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many keys generated. Try again later.' },
});
app.use('/api/', apiLimiter);

// ── Data ──────────────────────────────────────────────────────────────────────
const words = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data.json'), 'utf8'));
const byId = new Map(words.map(w => [w.id, w]));
const byEnglish = new Map(words.map(w => [w.english.toLowerCase(), w]));
const byFante = new Map(words.filter(w => w.fante).map(w => [w.fante.toLowerCase(), w]));

// ── Helpers ───────────────────────────────────────────────────────────────────
const baseUrl = req => `${req.protocol}://${req.get('host')}`;
const audioUrl = (req, sound) => `${baseUrl(req)}/audio/${sound}.mp3`;
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Auth middleware ───────────────────────────────────────────────────────────
const requireKey = asyncH(async (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'Missing API key. Pass as X-Api-Key header or ?api_key= param.' });
  if (typeof key !== 'string' || key.length > 100) return res.status(403).json({ error: 'Invalid or revoked API key.' });
  const row = await rpc('fante_check_key', { p_key: key, p_endpoint: req.path, p_query: req.query });
  if (!row) return res.status(403).json({ error: 'Invalid or revoked API key.' });
  if (row.quota_exceeded) return res.status(402).json({
    error: 'Monthly quota reached.', ...row,
    upgrade_url: `${baseUrl(req)}/#pricing`,
  });
  req.apiKey = row;
  next();
});

// ── Key endpoints ─────────────────────────────────────────────────────────────
app.post('/api/keys/generate', keygenLimiter, asyncH(async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100 || (email && String(email).length > 200)) return res.status(400).json({ error: 'name/email too long' });
  const out = await rpc('fante_generate_key', { p_name: name.trim(), p_email: email ? String(email) : '' });
  res.json({
    success: true, ...out,
    base_url: `${baseUrl(req)}/api`,
    docs_url: `${baseUrl(req)}/#developer`,
  });
}));

app.get('/api/keys/me', requireKey, (req, res) => res.json(req.apiKey));

// ── Vocab endpoints ───────────────────────────────────────────────────────────
app.get('/api/words', requireKey, (req, res) => {
  let result = words;
  const { category, search } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  if (category) result = result.filter(w => w.category === category);
  if (search) {
    const q = String(search).toLowerCase();
    result = result.filter(w => w.english.toLowerCase().includes(q) || (w.fante || '').toLowerCase().includes(q));
  }
  const total = result.length;
  result = result.slice(offset, offset + limit);
  res.json({ total, count: result.length, offset, words: result });
});

app.get('/api/words/:id', requireKey, (req, res) => {
  const w = byId.get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Word not found' });
  res.json({ ...w, audio_url: audioUrl(req, w.sound) });
});

app.get('/api/categories', requireKey, (req, res) => {
  const cats = {};
  words.forEach(w => { if (w.category) cats[w.category] = (cats[w.category] || 0) + 1; });
  res.json(Object.entries(cats).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)));
});

app.get('/api/translate', requireKey, (req, res) => {
  const { q, dir = 'en-fante' } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing ?q= query' });
  const query = String(q).toLowerCase().trim();
  const match = dir === 'en-fante'
    ? (byEnglish.get(query) || words.find(w => w.english.toLowerCase().includes(query)))
    : (byFante.get(query) || words.find(w => (w.fante || '').toLowerCase().includes(query)));
  if (!match) return res.status(404).json({ error: 'No translation found', query: q });
  res.json({
    english: match.english, fante: match.fante,
    category: match.category, sound: match.sound, id: match.id,
    audio_url: audioUrl(req, match.sound),
  });
});

app.get('/api/random', requireKey, (req, res) => {
  const { category } = req.query;
  const pool = category ? words.filter(w => w.category === category) : words;
  if (!pool.length) return res.status(404).json({ error: 'No words in that category' });
  const w = pool[Math.floor(Math.random() * pool.length)];
  res.json({ ...w, audio_url: audioUrl(req, w.sound) });
});

// ── NEW: Word of the day (deterministic per UTC date) ─────────────────────────
app.get('/api/word-of-the-day', requireKey, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (const c of today) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const w = words[hash % words.length];
  res.json({ date: today, ...w, audio_url: audioUrl(req, w.sound) });
});

// ── NEW: Quiz (multiple choice) ───────────────────────────────────────────────
app.get('/api/quiz', requireKey, (req, res) => {
  const { category, count = 1 } = req.query;
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 20);
  const pool = (category ? words.filter(w => w.category === category) : words).filter(w => w.fante);
  if (pool.length < 4) return res.status(404).json({ error: 'Not enough words in that category for a quiz' });
  const questions = [];
  for (let i = 0; i < n; i++) {
    const answer = pool[Math.floor(Math.random() * pool.length)];
    const distractors = new Set();
    while (distractors.size < 3) {
      const d = pool[Math.floor(Math.random() * pool.length)];
      if (d.id !== answer.id) distractors.add(d.fante);
    }
    const choices = [answer.fante, ...distractors].sort(() => Math.random() - 0.5);
    questions.push({
      question: `What is "${answer.english}" in Fante?`,
      english: answer.english,
      choices,
      answer: answer.fante,
      category: answer.category,
      audio_url: audioUrl(req, answer.sound),
    });
  }
  res.json({ count: questions.length, questions });
});

// ── Chat ──────────────────────────────────────────────────────────────────────
app.get('/api/chat', requireKey, (req, res) => {
  const text = String(req.query.message || '').toLowerCase().trim();
  const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
  if (greetings.some(g => text.includes(g))) {
    const w = words.find(x => x.category === 'greeting' && x.english.toLowerCase().includes('hello'))
      || words.find(x => x.category === 'greeting');
    return res.json({ reply: `Akwaaba! In Fante: "${w?.fante}" = "${w?.english}"`,
      audio_url: w ? audioUrl(req, w.sound) : null, word: w });
  }
  const sayMatch = text.match(/how (?:do you )?say (.+)/);
  if (sayMatch) {
    const target = sayMatch[1].trim();
    const match = byEnglish.get(target) || words.find(w => w.english.toLowerCase().includes(target));
    if (match) return res.json({ reply: `"${match.english}" in Fante is "${match.fante}"`,
      audio_url: audioUrl(req, match.sound), word: match });
    return res.json({ reply: `No Fante translation for "${target}" yet.`, audio_url: null, word: null });
  }
  const transMatch = text.match(/translate (.+)/);
  if (transMatch) {
    const target = transMatch[1].trim();
    const match = byEnglish.get(target) || words.find(w => w.english.toLowerCase().includes(target));
    if (match) return res.json({ reply: `${match.english} → ${match.fante}`,
      audio_url: audioUrl(req, match.sound), word: match });
    return res.json({ reply: `No translation found for "${target}".`, audio_url: null, word: null });
  }
  const random = words[Math.floor(Math.random() * words.length)];
  res.json({ reply: `Fante word: "${random.english}" = "${random.fante}"\nSay "how do you say [word]" to translate!`,
    audio_url: audioUrl(req, random.sound), word: random });
});

// ── Billing: plans, Paystack checkout (card / MTN MoMo / QR / USSD) ──────────
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PAYMENT_SECRET = process.env.PAYMENT_SECRET || '';

app.get('/api/plans', asyncH(async (req, res) => {
  const plans = await rpc('fante_get_plans', {});
  res.json({ currency: 'GHS', prepaid: { price_ghs: 10, calls: 1000, note: 'GH₵10 = 1,000 prepaid calls — never expire' },
    learner_pass: { price_ghs: 15, note: 'GH₵15/month — unlimited listening on the website' }, plans });
}));

// Start a checkout. kind: 'credits' | 'basic' | 'standard' | 'enterprise' | 'learner'
app.post('/api/pay/init', keygenLimiter, asyncH(async (req, res) => {
  const { email, kind, amount_ghs, api_key } = req.body || {};
  const KINDS = { credits: null, basic: 49, standard: 199, enterprise: 999, learner: 15 };
  if (!email || !/.+@.+\..+/.test(String(email))) return res.status(400).json({ error: 'Valid email required' });
  if (!(kind in KINDS)) return res.status(400).json({ error: 'Invalid kind' });
  const amount = kind === 'credits' ? Number(amount_ghs) : KINDS[kind];
  if (!amount || amount < 5 || amount > 100000) return res.status(400).json({ error: 'Invalid amount (min GH₵5)' });
  if (!PAYSTACK_SECRET) return res.json({
    setup_required: true,
    message: 'Payments are launching soon! Email us to subscribe manually.',
    contact: 'subscriptions@learnfanteapi.com',
  });
  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, amount: Math.round(amount * 100), currency: 'GHS',
      channels: ['card', 'mobile_money', 'qr', 'ussd', 'bank_transfer'],
      callback_url: `${baseUrl(req)}/?pay=verify`,
      metadata: { kind, api_key: api_key || '', custom_fields: [] },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!data.status) return res.status(502).json({ error: 'Payment init failed', detail: data.message });
  res.json({ checkout_url: data.data.authorization_url, reference: data.data.reference });
}));

// Verify + apply after Paystack redirects back
app.get('/api/pay/verify', asyncH(async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: 'Missing reference' });
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payments not configured yet' });
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }, signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!data.status || data.data.status !== 'success') return res.status(402).json({ error: 'Payment not completed', status: data.data && data.data.status });
  const meta = data.data.metadata || {};
  const out = await rpc('fante_apply_payment', {
    p_secret: PAYMENT_SECRET, p_reference: String(reference),
    p_key: meta.api_key || '', p_kind: meta.kind || 'credits',
    p_amount_ghs: data.data.amount / 100,
  });
  res.json({ success: true, kind: meta.kind, ...out });
}));

// ── Static audio, health, errors ──────────────────────────────────────────────
app.use('/audio', express.static(path.join(__dirname, 'audio'), { maxAge: '30d', immutable: true }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', words: words.length, version: VERSION }));

app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start & graceful shutdown ─────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`Fante API v${VERSION} → http://localhost:${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
