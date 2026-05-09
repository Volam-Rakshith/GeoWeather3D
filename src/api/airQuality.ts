/** Open-Meteo Air Quality API — free, no key, CORS-enabled */

const AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";

export type AirQualitySnapshot = {
  europeanAqi: number | null;
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  ozone: number | null;
  nitrogenDioxide: number | null;
};

export async function fetchAirQualityAt(
  lat: number,
  lon: number
): Promise<AirQualitySnapshot> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: "auto",
    current: [
      "european_aqi",
      "us_aqi",
      "pm10",
      "pm2_5",
      "carbon_monoxide",
      "nitrogen_dioxide",
      "ozone",
    ].join(","),
  });
  const res = await fetch(`${AIR}?${params}`);
  if (!res.ok) throw new Error("Air quality request failed");
  const data = (await res.json()) as {
    current: {
      european_aqi?: number | null;
      us_aqi?: number | null;
      pm10?: number | null;
      pm2_5?: number | null;
      nitrogen_dioxide?: number | null;
      ozone?: number | null;
    };
  };
  const c = data.current;
  return {
    europeanAqi: c.european_aqi ?? null,
    usAqi: c.us_aqi ?? null,
    pm25: c.pm2_5 ?? null,
    pm10: c.pm10 ?? null,
    ozone: c.ozone ?? null,
    nitrogenDioxide: c.nitrogen_dioxide ?? null,
  };
}
