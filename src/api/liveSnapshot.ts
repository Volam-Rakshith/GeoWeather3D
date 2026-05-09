import type { AirQualitySnapshot } from "./airQuality";
import { fetchAirQualityAt } from "./airQuality";
import type { CurrentWeather } from "./openMeteo";
import { fetchWeatherAt } from "./openMeteo";

export type LiveSnapshot = {
  weather: CurrentWeather;
  air: AirQualitySnapshot | null;
  /** Short notes when an optional API failed */
  partialWarnings: string[];
};

/** Hard cap so one slow API cannot block the UI for many seconds */
const WEATHER_MS = 8000;
const AIR_MS = 5000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, rej) => {
        timeoutId = setTimeout(() => rej(new Error("timeout")), ms);
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function fetchLiveSnapshot(
  lat: number,
  lon: number
): Promise<LiveSnapshot> {
  const warnings: string[] = [];

  const [wxResult, airResult] = await Promise.all([
    withTimeout(fetchWeatherAt(lat, lon), WEATHER_MS),
    withTimeout(fetchAirQualityAt(lat, lon), AIR_MS),
  ]);

  if (!wxResult.ok) {
    throw new Error("Weather request failed or timed out");
  }

  if (!airResult.ok) {
    warnings.push("Air quality skipped (slow or unavailable).");
  }

  return {
    weather: wxResult.value,
    air: airResult.ok ? airResult.value : null,
    partialWarnings: warnings,
  };
}
