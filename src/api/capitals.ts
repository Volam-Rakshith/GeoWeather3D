/**
 * National / administrative capital hints for the Discover panel.
 * — REST Countries (national capitals, ISO lookup)
 * — Wikidata (admin capital P36 for states/provinces when not in local table)
 */

import type { PlaceNames } from "./nominatim";
import {
  capitalForRegionPlaceName,
  type RegionCapitalInfo,
} from "../lib/regionFallbacks";

type PinLevel = "country" | "state" | "city";

const REST = "https://restcountries.com/v3.1";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent":
        "GeoWether3D/1.0 (local weather demo; capital lookup; educational use)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function pickCountryRecord(list: unknown[]): Record<string, unknown> {
  if (list.length <= 1) return (list[0] ?? {}) as Record<string, unknown>;
  const ind = list.filter(
    (c) => (c as { independent?: boolean }).independent !== false
  );
  return (ind[0] ?? list[0]) as Record<string, unknown>;
}

/** National capital via REST Countries (best-effort name / ISO match). */
async function fetchNationalCapital(
  countryName: string,
  countryCode: string | null | undefined,
  signal: AbortSignal
): Promise<RegionCapitalInfo | null> {
  const code = countryCode?.trim().toLowerCase();
  let list: unknown[];

  try {
    if (code && code.length === 2) {
      const url = `${REST}/alpha/${encodeURIComponent(code)}?fields=name,capital,cca2,independent`;
      const raw = await fetchJson<unknown>(url, signal);
      list = Array.isArray(raw) ? raw : [raw];
    } else {
      const url = `${REST}/name/${encodeURIComponent(countryName.trim())}?fullText=false&fields=name,capital,cca2,independent`;
      list = await fetchJson<unknown[]>(url, signal);
    }
  } catch {
    return null;
  }

  if (!Array.isArray(list) || list.length === 0) return null;

  let row = pickCountryRecord(list) as {
    name?: { common?: string };
    capital?: string[];
    cca2?: string;
  };

  if (code && list.length > 1) {
    const match = list.find(
      (c) =>
        String((c as { cca2?: string }).cca2 ?? "").toLowerCase() === code
    );
    if (match) row = match as typeof row;
  }

  const common = row.name?.common?.trim();
  const cap = row.capital?.[0]?.trim();
  if (!common || !cap) return null;

  return {
    regionName: common,
    capital: cap,
    country: common,
  };
}

type WbSearchHit = {
  id: string;
  label?: string;
  description?: string;
};

/** Administrative capital (P36) from Wikidata for states/provinces. */
async function fetchStateCapitalWikidata(
  stateName: string,
  countryName: string,
  signal: AbortSignal
): Promise<string | null> {
  const cn = countryName.toLowerCase();

  async function search(q: string): Promise<WbSearchHit[]> {
    const params = new URLSearchParams({
      action: "wbsearchentities",
      search: q,
      language: "en",
      format: "json",
      limit: "15",
      type: "item",
      origin: "*",
    });
    try {
      const data = await fetchJson<{ search?: WbSearchHit[] }>(
        `${WIKIDATA_API}?${params}`,
        signal
      );
      return data.search ?? [];
    } catch {
      return [];
    }
  }

  const queries = [`${stateName} ${countryName}`, stateName];
  const triedIds = new Set<string>();

  for (const q of queries) {
    const hits = await search(q);
    if (hits.length === 0) continue;

    const ranked = hits.filter((h) => {
      const d = (h.description ?? "").toLowerCase();
      return (
        d.includes(cn) ||
        d.includes("state of") ||
        d.includes("province") ||
        d.includes("region of") ||
        d.includes("federal state") ||
        d.includes("constituent") ||
        d.includes("oblast") ||
        d.includes("prefecture") ||
        d.includes("landschaft") ||
        d.includes("voivodeship") ||
        d.includes("canton")
      );
    });
    const candidates = ranked.length > 0 ? ranked : hits;

    for (const hit of candidates.slice(0, 10)) {
      if (triedIds.has(hit.id)) continue;
      triedIds.add(hit.id);
      const cap = await capitalEntityLabelFromItem(hit.id, signal);
      if (cap) return cap;
    }
  }
  return null;
}

async function capitalEntityLabelFromItem(
  itemId: string,
  signal: AbortSignal
): Promise<string | null> {
  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: itemId,
    props: "claims",
    format: "json",
    origin: "*",
  });
  let data: {
    entities?: Record<
      string,
      {
        claims?: {
          P36?: Array<{
            mainsnak?: {
              datavalue?: { value?: { id?: string } };
            };
          }>;
        };
      }
    >;
  };
  try {
    data = await fetchJson(`${WIKIDATA_API}?${params}`, signal);
  } catch {
    return null;
  }

  const ent = data.entities?.[itemId];
  const stmts = ent?.claims?.P36 ?? [];
  for (const stmt of stmts) {
    const vid =
      stmt?.mainsnak?.datavalue?.value &&
      typeof stmt.mainsnak.datavalue.value === "object" &&
      "id" in stmt.mainsnak.datavalue.value
        ? (stmt.mainsnak.datavalue.value as { id: string }).id
        : null;
    if (!vid || !/^Q\d+$/.test(vid)) continue;

    const lp = new URLSearchParams({
      action: "wbgetentities",
      ids: vid,
      props: "labels",
      languages: "en",
      format: "json",
      origin: "*",
    });
    let labels: {
      entities?: Record<string, { labels?: { en?: { value?: string } } }>;
    };
    try {
      labels = await fetchJson(`${WIKIDATA_API}?${lp}`, signal);
    } catch {
      continue;
    }

    const label = labels.entities?.[vid]?.labels?.en?.value?.trim();
    if (label) return label;
  }
  return null;
}

export async function resolveCapitalForDiscover(
  activePinLevel: PinLevel,
  placeNames: PlaceNames,
  signal: AbortSignal
): Promise<RegionCapitalInfo | null> {
  const country = placeNames.country?.trim();
  const state = placeNames.state?.trim();

  if (activePinLevel === "country" && country) {
    return fetchNationalCapital(country, placeNames.countryCode, signal);
  }

  if (activePinLevel === "state" && state) {
    const local = capitalForRegionPlaceName(state);
    if (local) return local;
    if (country) {
      const cap = await fetchStateCapitalWikidata(state, country, signal);
      if (cap) return { regionName: state, capital: cap, country };
    }
    return null;
  }

  /* City (and generic): show national capital when we know the country */
  if (activePinLevel === "city" && country) {
    return fetchNationalCapital(country, placeNames.countryCode, signal);
  }

  return null;
}
