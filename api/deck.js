// Shared saving for the slide kit. One small Vercel Function, no build step.
//
//   GET  /api/deck   -> { rev, needKey, state }   the latest published deck
//   PUT  /api/deck   -> { rev }                   publish a new version
//
// Every save is stored as its own file (deck/r000000012.json) in Vercel Blob, so two people
// saving at the same time can never silently overwrite each other: the second save is refused
// and the page asks what to do. The last 12 versions are kept as backups.
//
// Optional setting (Vercel > Settings > Environment Variables):
//   DECK_EDIT_KEY   if set, only people who enter this key can publish changes. Everyone can still view.

const crypto = require('crypto');

const PREFIX = 'deck/';
const KEEP = 12;
const MAX_BYTES = 4.4 * 1024 * 1024;
const pad = n => String(n).padStart(9, '0');
const pathFor = rev => PREFIX + 'r' + pad(rev) + '.json';
const revOf = pathname => parseInt(pathname.slice(PREFIX.length + 1, -'.json'.length), 10);

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function makeHandler(blobLib) {
  const lib = () => blobLib || import('@vercel/blob');

  async function versions() {
    const { list } = await lib();
    const out = []; let cursor;
    do {
      const r = await list({ prefix: PREFIX, cursor, limit: 1000 });
      out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.filter(b => /\/r\d+\.json$/.test(b.pathname)).sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
  }

  async function readLatest() {
    const all = await versions();
    if (!all.length) return { rev: 0, state: null, all };
    const last = all[all.length - 1];
    const r = await fetch(last.url);
    if (!r.ok) throw new Error('Could not read the saved deck');
    const j = await r.json();
    return { rev: revOf(last.pathname), state: j.state, savedAt: j.savedAt, all };
  }

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const needKey = !!process.env.DECK_EDIT_KEY;
    if (!blobLib && !process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(503).json({ error: 'Storage is not connected. Add a Blob store to this Vercel project.', needKey });
    }
    try {
      if (req.method === 'GET') {
        const cur = await readLatest();
        return res.status(200).json({ rev: cur.rev, needKey, savedAt: cur.savedAt || null, state: cur.state });
      }

      if (req.method === 'PUT' || req.method === 'POST') {
        if (needKey && !same(req.headers['x-edit-key'] || '', process.env.DECK_EDIT_KEY)) {
          return res.status(401).json({ error: 'Edit key needed', needKey });
        }
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
        const st = body && body.state;
        if (!body || typeof body.baseRev !== 'number' || !st || typeof st.deck !== 'string' || !/class="slide/.test(st.deck) ||
            (st.presets && (!Array.isArray(st.presets) || st.presets.length > 200 || st.presets.some(p => typeof p !== 'string')))) {
          return res.status(400).json({ error: 'That is not a deck.' });
        }
        const text = JSON.stringify({ savedAt: new Date().toISOString(), state: { deck: st.deck, presets: st.presets || [] } });
        if (Buffer.byteLength(text) > MAX_BYTES) return res.status(413).json({ error: 'The deck is too large to share.' });

        const cur = await readLatest();
        if (body.baseRev !== cur.rev) return res.status(409).json({ error: 'Someone else saved first.', rev: cur.rev, state: cur.state });

        const { put, del } = await lib();
        const rev = cur.rev + 1;
        try {
          await put(pathFor(rev), JSON.stringify({ rev, ...JSON.parse(text) }), {
            access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json', cacheControlMaxAge: 31536000
          });
        } catch (e) {
          if (/already exists/i.test(String(e && e.message))) {
            const again = await readLatest();
            return res.status(409).json({ error: 'Someone else saved first.', rev: again.rev, state: again.state });
          }
          throw e;
        }
        const old = cur.all.slice(0, Math.max(0, cur.all.length + 1 - KEEP)).map(b => b.url);
        if (old.length) { try { await del(old); } catch (e) { /* old backups are best effort */ } }
        return res.status(200).json({ rev });
      }

      res.setHeader('Allow', 'GET, PUT');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Server error' });
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
