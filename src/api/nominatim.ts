/**
 * OpenStreetMap Nominatim — free, no API key.
 * https://operations.osmfoundation.org/policies/nominatim/ — be polite: ~1 req/s, identify User-Agent.
 */

import type { GeocodeHit } from "./geocodeTypes";
import { presentablePlaceText } from "../lib/presentablePlaceName";

const BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT =
  "GeoWether3D/1.0 (local weather demo; educational use; +https://openstreetmap.org/copyright)";

export type PlaceNames = {
  country: string | null;
  state: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2 (lowercase) for flag CDN */
  countryCode: string | null;
  /** Full Nominatim description when city/state/country are sparse (ocean, desert, peaks, etc.) */
  detailLine?: string | null;
};

export type LatLon = { lat: number; lon: number };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

async function fetchJson<T>(
  url: string,
  signal: AbortSignal
): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return (await res.json()) as T;
}

function parseAddress(addr: Record<string, string>): PlaceNames {
  const country = addr.country ?? null;
  const state =
    addr.state ??
    addr.region ??
    addr.province ??
    addr.state_district ??
    null;
  /** Smallest useful label: settlements first, then natural / admin features for “random” clicks */
  const city =
    addr.city ??
    addr.town ??
    addr.village ??
    addr.hamlet ??
    addr.municipality ??
    addr.city_district ??
    addr.suburb ??
    addr.neighbourhood ??
    addr.quarter ??
    addr.locality ??
    addr.district ??
    addr.county ??
    addr.island ??
    addr.islet ??
    addr.ocean ??
    addr.sea ??
    addr.bay ??
    addr.strait ??
    addr.water ??
    addr.desert ??
    addr.peak ??
    addr.volcano ??
    addr.natural ??
    addr.national_park ??
    addr.protected_area ??
    addr.residential ??
    addr.aeroway ??
    addr.road ??
    null;

  const rawCode = (addr.country_code ?? "").trim().toLowerCase();
  const countryCode =
    rawCode.length === 2 ? rawCode : null;

  return { country, state, city, countryCode };
}

function withDisplayNameFallback(
  names: PlaceNames,
  displayName: string | null
): PlaceNames {
  const hasStructured =
    (names.city && names.city.trim()) ||
    (names.state && names.state.trim()) ||
    (names.country && names.country.trim());
  if (hasStructured) return names;
  const line = displayName?.trim();
  if (!line) return names;
  return { ...names, detailLine: line };
}

export async function nominatimReverse(
  lat: number,
  lon: number,
  signal: AbortSignal,
  opts?: { zoom?: number }
): Promise<PlaceNames> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "json",
    addressdetails: "1",
  });
  if (opts?.zoom != null) {
    params.set("zoom", String(opts.zoom));
  }
  const url = `${BASE}/reverse?${params.toString()}`;
  const j = await fetchJson<{
    address?: Record<string, string>;
    display_name?: string;
  }>(url, signal);
  const names = parseAddress(j.address ?? {});
  return withDisplayNameFallback(names, j.display_name ?? null);
}

function rethrowIfAborted(e: unknown): void {
  if (e instanceof DOMException && e.name === "AbortError") throw e;
}

export type NominatimFeatureType = "country" | "state" | "city" | "settlement";

export async function nominatimSearchFirst(
  query: string,
  signal: AbortSignal,
  opts?: { featureType?: NominatimFeatureType }
): Promise<LatLon | null> {
  const q = query.trim();
  if (!q) return null;
  const params = new URLSearchParams({
    q,
    format: "json",
    limit: "1",
  });
  if (opts?.featureType) {
    params.set("featureType", opts.featureType);
  }
  const url = `${BASE}/search?${params.toString()}`;
  const arr = await fetchJson<{ lat: string; lon: string }[]>(url, signal);
  if (!arr?.length) return null;
  return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
}

export type AdministrativePins = {
  country: LatLon | null;
  state: LatLon | null;
  city: LatLon;
};

const BETWEEN_MS = 450;

export async function resolveAdministrativePins(
  cityLat: number,
  cityLon: number,
  signal: AbortSignal
): Promise<{ names: PlaceNames; pins: AdministrativePins }> {
  const names = await nominatimReverse(cityLat, cityLon, signal, {
    zoom: 12,
  });
  const city: LatLon = { lat: cityLat, lon: cityLon };

  let country: LatLon | null = null;
  let state: LatLon | null = null;

  if (names.country) {
    try {
      await sleep(BETWEEN_MS, signal);
      country = await nominatimSearchFirst(names.country, signal, {
        featureType: "country",
      });
    } catch (e) {
      rethrowIfAborted(e);
      country = null;
    }
  }

  if (names.state && names.country) {
    try {
      await sleep(BETWEEN_MS, signal);
      state = await nominatimSearchFirst(
        `${names.state}, ${names.country}`,
        signal,
        { featureType: "state" }
      );
    } catch (e) {
      rethrowIfAborted(e);
      state = null;
    }
  } else if (names.state) {
    try {
      await sleep(BETWEEN_MS, signal);
      state = await nominatimSearchFirst(names.state, signal, {
        featureType: "state",
      });
    } catch (e) {
      rethrowIfAborted(e);
      state = null;
    }
  }

  if (
    country &&
    state &&
    Math.hypot(country.lat - state.lat, country.lon - state.lon) < 0.08
  ) {
    state = null;
  }

  return {
    names,
    pins: { country, state, city },
  };
}

export async function resolveFromGeocodeHit(
  hit: GeocodeHit,
  signal: AbortSignal
): Promise<{ names: PlaceNames; pins: AdministrativePins }> {
  const city: LatLon = { lat: hit.latitude, lon: hit.longitude };
  const names: PlaceNames = {
    country: hit.country ?? null,
    state: hit.admin1 ?? null,
    city: hit.name ?? null,
    countryCode: hit.country_code?.trim().toLowerCase() ?? null,
  };

  const fc = hit.feature_code?.toUpperCase();
  if (!names.country?.trim() && fc === "CONT") {
    names.country = hit.name ?? null;
  }

  let country: LatLon | null = null;
  let state: LatLon | null = null;

  if (names.country) {
    try {
      country = await nominatimSearchFirst(names.country, signal, {
        featureType: "country",
      });
    } catch (e) {
      rethrowIfAborted(e);
      country = null;
    }
    await sleep(BETWEEN_MS, signal);
  }

  if (names.state && names.country) {
    try {
      state = await nominatimSearchFirst(
        `${names.state}, ${names.country}`,
        signal,
        { featureType: "state" }
      );
    } catch (e) {
      rethrowIfAborted(e);
      state = null;
    }
  } else if (names.state) {
    try {
      await sleep(BETWEEN_MS, signal);
      state = await nominatimSearchFirst(names.state, signal, {
        featureType: "state",
      });
    } catch (e) {
      rethrowIfAborted(e);
      state = null;
    }
  }

  if (
    country &&
    state &&
    Math.hypot(country.lat - state.lat, country.lon - state.lon) < 0.08
  ) {
    state = null;
  }

  if (!names.countryCode) {
    try {
      await sleep(BETWEEN_MS, signal);
      const rev = await nominatimReverse(city.lat, city.lon, signal, {
        zoom: 12,
      });
      names.countryCode = rev.countryCode;
    } catch (e) {
      rethrowIfAborted(e);
    }
  }

  return { names, pins: { country, state, city } };
}

function presentableSegment(s: string | null | undefined): string | null {
  if (!s?.trim()) return null;
  return presentablePlaceText(s.trim());
}

export function normalizePlaceNames(names: PlaceNames): PlaceNames {
  const detail = names.detailLine?.trim();
  return {
    ...names,
    country: presentableSegment(names.country),
    state: presentableSegment(names.state),
    city: presentableSegment(names.city),
    detailLine: detail ? presentablePlaceText(detail) : null,
  };
}

export function formatPlaceLabel(names: PlaceNames): string {
  const raw = [
    presentableSegment(names.city),
    presentableSegment(names.state),
    presentableSegment(names.country),
  ].filter((x): x is string => Boolean(x));
  const parts: string[] = [];
  for (const p of raw) {
    if (parts[parts.length - 1] !== p) parts.push(p);
  }
  const joined = parts.join(" · ");
  if (joined) return joined;
  if (names.detailLine?.trim())
    return presentablePlaceText(names.detailLine.trim());
  return "Unknown area";
}
