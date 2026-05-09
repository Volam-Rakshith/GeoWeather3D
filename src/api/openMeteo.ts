/** Open-Meteo — free tier, no API key, HTTPS + CORS for browsers */

import { matchRegionFallbacks } from "../lib/regionFallbacks";
import type { GeocodeHit } from "./geocodeTypes";

export type { GeocodeHit } from "./geocodeTypes";

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const WX = "https://api.open-meteo.com/v1/forecast";
const ELEV = "https://api.open-meteo.com/v1/elevation";

/** Copernicus DEM elevation (m) — passed into forecast for statistical downscaling (closer to surface/station-like temps). */
async function fetchElevationMeters(
  lat: number,
  lon: number
): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
    });
    const res = await fetch(`${ELEV}?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { elevation?: number[] };
    const e = data.elevation?.[0];
    return typeof e === "number" && Number.isFinite(e) ? e : null;
  } catch {
    return null;
  }
}

export async function searchPlaces(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeHit[]> {
  const q = query.trim();
  if (!q) return [];

  const fallback = matchRegionFallbacks(q);

  const url = `${GEO}?name=${encodeURIComponent(q)}&count=20&language=en&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("Geocoding failed");
  const data = (await res.json()) as { results?: GeocodeHit[] };
  const api = data.results ?? [];

  if (fallback.length === 0) return api;

  const seen = new Set(
    fallback.map((h) => `${h.latitude.toFixed(4)}:${h.longitude.toFixed(4)}`)
  );
  const rest = api.filter(
    (h) => !seen.has(`${h.latitude.toFixed(4)}:${h.longitude.toFixed(4)}`)
  );
  return [...fallback, ...rest];
}

export type CurrentWeather = {
  temperature: number;
  apparent: number;
  humidity: number;
  windKmh: number;
  windDirectionDeg: number | null;
  windGustsKmh: number | null;
  weatherCode: number;
  isDay: boolean;
  uvIndex: number | null;
  cloudCoverPct: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  showersMm: number | null;
  pressureHpa: number | null;
  /** Local wall time at the pin (from Open-Meteo, timezone-aware) */
  localTimeIso: string;
  /** IANA timezone e.g. America/New_York */
  timezone: string;
};

export async function fetchWeatherAt(
  lat: number,
  lon: number
): Promise<CurrentWeather> {
  const elevationM = await fetchElevationMeters(lat, lon);

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: "auto",
    /** Prefer land grid cells (avoids sea ice / open-ocean cells near coasts). */
    cell_selection: "land",
    temperature_unit: "celsius",
    current:
      [
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "weather_code",
        "is_day",
        "precipitation",
        "rain",
        "showers",
        "cloud_cover",
        "pressure_msl",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
        "uv_index",
      ].join(","),
    wind_speed_unit: "kmh",
  });
  if (elevationM != null) {
    params.set("elevation", String(elevationM));
  }
  const res = await fetch(`${WX}?${params}`);
  if (!res.ok) throw new Error("Weather request failed");
  const data = (await res.json()) as {
    timezone?: string;
    current: {
      time: string;
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      wind_speed_10m: number;
      wind_direction_10m?: number | null;
      wind_gusts_10m?: number | null;
      weather_code: number;
      is_day: 0 | 1;
      precipitation?: number | null;
      rain?: number | null;
      showers?: number | null;
      cloud_cover?: number | null;
      pressure_msl?: number | null;
      uv_index?: number | null;
    };
  };
  const c = data.current;
  const tz = data.timezone ?? "UTC";
  return {
    temperature: c.temperature_2m,
    apparent: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    windKmh: c.wind_speed_10m,
    windDirectionDeg:
      c.wind_direction_10m != null ? c.wind_direction_10m : null,
    windGustsKmh: c.wind_gusts_10m ?? null,
    weatherCode: c.weather_code,
    isDay: c.is_day === 1,
    uvIndex: c.uv_index ?? null,
    cloudCoverPct: c.cloud_cover ?? null,
    precipitationMm: c.precipitation ?? null,
    rainMm: c.rain ?? null,
    showersMm: c.showers ?? null,
    pressureHpa: c.pressure_msl ?? null,
    localTimeIso: c.time,
    timezone: tz,
  };
}

/** Hour from Open-Meteo `current.time` (already local wall clock at the location). */
export function localHourFromIso(iso: string): number {
  const m = iso.match(/T(\d{2}):/);
  return m ? parseInt(m[1], 10) : 12;
}

/** Morning / Afternoon / Evening / Night from local hour at the place */
export function describeLocalPeriod(hour: number): string {
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 21) return "Evening";
  return "Night";
}

export function formatLocalWallClock(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${min} ${ampm}`;
}

export function formatTimezoneShort(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    return name ?? tz;
  } catch {
    return tz;
  }
}

export function windCompass(degrees: number | null): string {
  if (degrees == null || Number.isNaN(degrees)) return "—";
  const d = ((degrees % 360) + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const i = Math.round(d / 45) % 8;
  return `${dirs[i]} (${Math.round(degrees)}°)`;
}

/** WMO Weather interpretation codes (subset) */
export function describeWeatherCode(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with heavy hail",
  };
  return map[code] ?? `Weather code ${code}`;
}
