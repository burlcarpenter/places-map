// Category resolution. Reads data/categories.json so the taxonomy stays editable
// without touching code — the future desktop editor consumes the same file.

let taxonomy = null;
let defaults = null;

export async function loadTaxonomy() {
  if (taxonomy) return taxonomy;
  const res = await fetch('data/categories.json');
  if (!res.ok) throw new Error(`Could not load categories.json (${res.status})`);
  defaults = await res.json();
  taxonomy = defaults;
  return taxonomy;
}

/**
 * The places file may carry its own `categories` array — that is where the
 * desktop editor writes the taxonomy, so it travels with the data and needs no
 * separate deploy. Keyword rules are not editable there, so any bucket that
 * shares an id with a built-in one inherits its `match` rules; genuinely new
 * buckets get none, which is correct since they are only ever assigned by hand.
 *
 * Returns true when the taxonomy changed, so callers can rebuild marker icons.
 */
export function applyTaxonomyFrom(geojson) {
  const fromFile = geojson?.categories;
  const base = defaults ?? { buckets: [], weakTokens: [] };

  const next = (Array.isArray(fromFile) && fromFile.length)
    ? {
        weakTokens: base.weakTokens ?? [],
        buckets: fromFile.map(c => ({
          ...c,
          match: Array.isArray(c.match) && c.match.length
            ? c.match
            : (base.buckets.find(b => b.id === c.id)?.match ?? [])
        }))
      }
    : base;

  const changed = JSON.stringify(next.buckets) !== JSON.stringify(taxonomy?.buckets);
  taxonomy = next;
  return changed;
}

/**
 * Always present, in every file, without needing to be created or edited in
 * per-file categories.json/state.data.categories — a place flagged this way
 * hasn't been fully vetted yet, regardless of whatever real category it also
 * carries. Not part of the user-editable taxonomy on purpose: deleting it
 * would silently break every place still marked unvetted.
 */
export const RESEARCH_NEEDED = { id: 'research-needed', label: 'Research Needed', emoji: '🔍', color: '#e0592a' };

function allBuckets() {
  return [...taxonomy.buckets, RESEARCH_NEEDED];
}

export function buckets() {
  return allBuckets();
}

export function bucketById(id) {
  return allBuckets().find(b => b.id === id) ?? taxonomy.buckets.at(-1);
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
 * Resolve a GeoJSON feature to 1–2 bucket ids. Capped at two — the pin's
 * split-colour rendering only reads cleanly as two halves; a third would
 * need pie slices nobody asked for.
 *
 * 1. properties.user.buckets (array) wins outright if present — the
 *    multi-select override the desktop editor writes, and nothing here may
 *    second-guess it.
 * 2. Falls back to the legacy singular properties.user.bucket, so every
 *    place categorised before multi-category existed keeps working with no
 *    migration step required.
 * 3. Otherwise scan the raw Google category string, same as before: strong
 *    tokens first in Google's own order (the first is primary), weak ones
 *    like "tourist attraction" only once no strong token has matched.
 * 4. Falls back to 'other'.
 */
export function resolveBuckets(props = {}) {
  const validIds = new Set(allBuckets().map(b => b.id));

  if (Array.isArray(props.user?.buckets) && props.user.buckets.length) {
    const valid = props.user.buckets.filter(b => validIds.has(b));
    if (valid.length) return valid.slice(0, 2);
  }
  if (props.user?.bucket && validIds.has(props.user.bucket)) {
    return [props.user.bucket];
  }

  const tokens = categoryTokens(props.category).map(t => t.toLowerCase());
  if (!tokens.length) return ['other'];

  const isWeak = t => taxonomy.weakTokens.includes(t);

  for (const t of tokens.filter(t => !isWeak(t))) {
    const hit = classifyToken(t);
    if (hit) return [hit];
  }
  for (const t of tokens.filter(isWeak)) {
    const hit = classifyToken(t);
    if (hit) return [hit];
  }
  return ['other'];
}

/**
 * Annotate a FeatureCollection in place:
 *   _buckets   — the resolved array, 1–2 ids, in the place's own order
 *   _bucketKey — a stable, order-independent string picking the marker
 *                sprite: one id alone, or both alphabetised and joined, so
 *                ['cafe','museum'] and ['museum','cafe'] share one sprite
 *                rather than needing two.
 */
export function annotate(geojson) {
  for (const f of geojson.features ?? []) {
    f.properties = f.properties ?? {};
    const b = resolveBuckets(f.properties);
    f.properties._buckets = b;
    f.properties._bucketKey = [...b].sort().join('+');
  }
  return geojson;
}
