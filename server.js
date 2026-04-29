const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3747;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data ──────────────────────────────────────────────────────────────────────
const words = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data.json'), 'utf8'));
const byId = new Map(words.map(w => [w.id, w]));
const byEnglish = new Map(words.map(w => [w.english.toLowerCase(), w]));
const byFante = new Map(words.filter(w => w.fante).map(w => [w.fante.toLowerCase(), w]));

// ── API Key DB ────────────────────────────────────────────────────────────────
const keysDb = new Database(path.join(__dirname, 'keys.db'));
keysDb.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    created_at TEXT,
    last_used TEXT,
    request_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT, endpoint TEXT, query TEXT, ts TEXT
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function audioUrl(req, sound) {
  return `${baseUrl(req)}/audio/${sound}.mp3`;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'Missing API key. Pass as X-Api-Key header or ?api_key= param.' });
  const row = keysDb.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1').get(key);
  if (!row) return res.status(403).json({ error: 'Invalid or revoked API key.' });
  keysDb.prepare('UPDATE api_keys SET last_used = ?, request_count = request_count + 1 WHERE key = ?')
    .run(new Date().toISOString(), key);
  keysDb.prepare('INSERT INTO request_log (key, endpoint, query, ts) VALUES (?, ?, ?, ?)')
    .run(key, req.path, JSON.stringify(req.query), new Date().toISOString());
  req.apiKey = row;
  next();
}

// ── Key endpoints ─────────────────────────────────────────────────────────────
app.post('/api/keys/generate', (req, res) => {
  const { name, email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const key = 'fante_' + uuidv4().replace(/-/g, '');
  keysDb.prepare('INSERT INTO api_keys (key, name, email, created_at) VALUES (?, ?, ?, ?)')
    .run(key, name, email || '', new Date().toISOString());
  res.json({
    success: true, api_key: key, name,
    created_at: new Date().toISOString(),
    base_url: `${baseUrl(req)}/api`,
    docs_url: `${baseUrl(req)}/#developer`,
  });
});

app.get('/api/keys/me', requireKey, (req, res) => res.json(req.apiKey));

// ── Vocab endpoints ───────────────────────────────────────────────────────────
app.get('/api/words', requireKey, (req, res) => {
  let result = words;
  const { category, search, limit = 50, offset = 0 } = req.query;
  if (category) result = result.filter(w => w.category === category);
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(w => w.english.toLowerCase().includes(q) || (w.fante || '').toLowerCase().includes(q));
  }
  const total = result.length;
  result = result.slice(Number(offset), Number(offset) + Number(limit));
  res.json({ total, count: result.length, offset: Number(offset), words: result });
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
  const query = q.toLowerCase().trim();
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

app.get('/api/chat', requireKey, (req, res) => {
  const text = (req.query.message || '').toLowerCase().trim();
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

app.get('/api/random', requireKey, (req, res) => {
  const { category } = req.query;
  const pool = category ? words.filter(w => w.category === category) : words;
  if (!pool.length) return res.status(404).json({ error: 'No words in that category' });
  const w = pool[Math.floor(Math.random() * pool.length)];
  res.json({ ...w, audio_url: audioUrl(req, w.sound) });
});

app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.get('/api/health', (req, res) => res.json({ status: 'ok', words: words.length, version: '1.0.0' }));

app.listen(PORT, () => console.log(`Fante API → http://localhost:${PORT}`));
