import type { AdministrativePins, PlaceNames } from "../api/nominatim";
import type { GeocodeHit } from "../api/geocodeTypes";
import type { AdminPinLevel } from "../components/GlobeScene";

/**
 * Maps Open-Meteo / GeoNames `feature_code` to the focus tier the user expects
 * when picking a search result (country vs state vs city).
 */
export function pinLevelFromGeocodeHit(hit: GeocodeHit): AdminPinLevel | null {
  const fc = hit.feature_code?.toUpperCase();
  if (!fc) return null;

  if (fc.startsWith("PCL") || fc === "CONT") {
    return "country";
  }

  if (fc === "ADM1") {
    return "state";
  }

  if (fc.startsWith("ADM") && fc !== "ADM1") {
    return "city";
  }

  if (fc.startsWith("PPL")) {
    return "city";
  }

  return null;
}

/** If the chosen tier has no data, fall back to the best available pin. */
export function clampPinLevelToResolvedData(
  level: AdminPinLevel,
  pins: AdministrativePins,
  names: PlaceNames
): AdminPinLevel {
  const hasCountry =
    Boolean(pins.country) || Boolean(names.country?.trim());
  const hasState = Boolean(pins.state) || Boolean(names.state?.trim());

  if (level === "country") {
    if (hasCountry) return "country";
    if (hasState) return "state";
    return "city";
  }
  if (level === "state") {
    if (hasState) return "state";
    if (hasCountry) return "country";
    return "city";
  }
  return "city";
}
