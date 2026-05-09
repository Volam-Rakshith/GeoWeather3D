export type GeocodeHit = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  /** ISO 3166-1 alpha-2 from Open-Meteo / synthetic hits */
  country_code?: string;
  /** GeoNames code from Open-Meteo (e.g. PCLI, ADM1, PPL, CONT) */
  feature_code?: string;
};
