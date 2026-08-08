// GitHub private-repo fetch. Same call Phase 0 validated — 200 in ~486ms, CORS clean.

export async function fetchPlaces({ owner, repo, path, token }) {
  if (!owner || !repo || !path || !token) {
    throw new Error('Missing GitHub settings. Open Settings and fill all four fields.');
  }

  const safePath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${safePath}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch {
    throw new Error('Network unreachable. You are probably offline — cached places are still loaded.');
  }

  if (res.status === 401) throw new Error('Token rejected. It may have expired — generate a new one in Settings.');
  if (res.status === 403) throw new Error('Forbidden. Rate limited, or the token lost its Contents permission.');
  if (res.status === 404) throw new Error('Not found. Check the filename, repo name, and that the token is scoped to this repo.');
  if (!res.ok) throw new Error(`GitHub returned ${res.status} ${res.statusText}`);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file downloaded but is not valid JSON.');
  }
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Downloaded JSON is not a GeoJSON FeatureCollection.');
  }
  return data;
}

/** Compare an incoming collection against the cached one, keyed on placeId. */
export function diff(oldData, newData) {
  const key = f => f.properties?.placeId ?? f.properties?.name;
  const before = new Set((oldData?.features ?? []).map(key));
  const after = new Set((newData.features ?? []).map(key));

  let added = 0, removed = 0;
  for (const k of after) if (!before.has(k)) added++;
  for (const k of before) if (!after.has(k)) removed++;
  return { added, removed, total: after.size };
}
