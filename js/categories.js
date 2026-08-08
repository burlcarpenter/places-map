// Category resolution. Reads data/categories.json so the taxonomy stays editable
// without touching code — the future desktop editor consumes the same file.

let taxonomy = null;

export async function loadTaxonomy() {
  if (taxonomy) return taxonomy;
  const res = await fetch('data/categories.json');
  if (!res.ok) throw new Error(`Could not load categories.json (${res.status})`);
  taxonomy = await res.json();
  return taxonomy;
}

export function buckets() {
  return taxonomy.buckets;
}

export function bucketById(id) {
  return taxonomy.buckets.find(b => b.id === id) ?? taxonomy.buckets.at(-1);
}

/**
 * Does one raw token match one bucket's rules?
 * A rule prefixed with '=' requires an exact token match; otherwise substring.
 */
function tokenHitsBucket(token, bucket) {
  return bucket.match.some(rule =>
    rule.startsWith('=') ? token === rule.slice(1) : token.includes(rule)
  );
}

function classifyToken(token) {
  for (const bucket of taxonomy.buckets) {
    if (bucket.match.length && tokenHitsBucket(token, bucket)) return bucket.id;
  }
  return null;
}

/**
 * Fields in this dataset arrive in three shapes depending on which export wrote
 * them: a real array, a JSON-encoded string of one, or a plain string. Normalise
 * before anything downstream touches them.
 */
export function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return v;
  try { return JSON.parse(s); } catch { return v; }
}

/**
 * properties.category, as an ordered token list with the primary category first.
 * Handles array, JSON-string, and comma-joined-string forms.
 */
export function categoryTokens(raw) {
  const val = parseMaybeJson(raw);
  const parts = Array.isArray(val) ? val : String(val ?? '').split(',');
  return parts.map(t => String(t ?? '').trim()).filter(Boolean);
}

/** Human-readable form for display: "Market · Tourist attraction". */
export function categoryLabel(raw) {
  return categoryTokens(raw).join(' · ');
}

/**
 * Resolve a GeoJSON feature to a bucket id.
 *
 * 1. properties.user.bucket wins outright — that's the manual override the
 *    desktop editor writes, and nothing here may second-guess it.
 * 2. Otherwise scan the raw Google category string. Strong tokens first, in the
 *    order Google listed them (the first is the primary category). Weak tokens
 *    like "tourist attraction" are so generic they'd swallow everything, so they
 *    only get a say once no strong token has matched.
 * 3. Fall back to 'other'.
 */
export function resolveBucket(props = {}) {
  const override = props.user?.bucket;
  if (override && taxonomy.buckets.some(b => b.id === override)) return override;

  const tokens = categoryTokens(props.category).map(t => t.toLowerCase());
  if (!tokens.length) return 'other';

  const isWeak = t => taxonomy.weakTokens.includes(t);

  for (const t of tokens.filter(t => !isWeak(t))) {
    const hit = classifyToken(t);
    if (hit) return hit;
  }
  for (const t of tokens.filter(isWeak)) {
    const hit = classifyToken(t);
    if (hit) return hit;
  }
  return 'other';
}

/** Annotate a FeatureCollection in place, adding properties._bucket to each feature. */
export function annotate(geojson) {
  for (const f of geojson.features ?? []) {
    f.properties = f.properties ?? {};
    f.properties._bucket = resolveBucket(f.properties);
  }
  return geojson;
}
