import type { GeocodeHit } from "../api/geocodeTypes";

/**
 * Open-Meteo search indexes populated places (PPL*) well but often returns nothing
 * for first-order admin names (e.g. Indian states, some US states mixed with
 * homonyms). We merge these representative points when the query matches.
 */

type RegionRow = {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  /** Administrative capital (or seat) for states / UTs in this table */
  capital: string;
};

function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[,'"]/g, "");
}

/** Stable negative id so list keys stay unique vs GeoNames ids */
function syntheticId(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  }
  return h <= 0 ? h - 1 : -h;
}

const ALIASES: Record<string, string> = {
  telengana: "telangana",
  /** Former official English name in some datasets */
  orissa: "odisha",
  pondicherry: "puducherry",
  pondichéry: "puducherry",
  /** US */
  dc: "district of columbia",
  "washington dc": "district of columbia",
  "washington d.c.": "district of columbia",
};

/** Keys must be normalized with normalizeQuery */
const REGIONS: Record<string, RegionRow> = {
  // India — states (coordinates at capital / seat)
  "andhra pradesh": {
    name: "Andhra Pradesh",
    latitude: 16.53,
    longitude: 80.52,
    country: "India",
    capital: "Amaravati",
  },
  "arunachal pradesh": {
    name: "Arunachal Pradesh",
    latitude: 27.0844,
    longitude: 93.6053,
    country: "India",
    capital: "Itanagar",
  },
  assam: {
    name: "Assam",
    latitude: 26.14,
    longitude: 91.79,
    country: "India",
    capital: "Dispur",
  },
  bihar: {
    name: "Bihar",
    latitude: 25.5941,
    longitude: 85.1376,
    country: "India",
    capital: "Patna",
  },
  chhattisgarh: {
    name: "Chhattisgarh",
    latitude: 21.2514,
    longitude: 81.6296,
    country: "India",
    capital: "Raipur",
  },
  goa: {
    name: "Goa",
    latitude: 15.4909,
    longitude: 73.8278,
    country: "India",
    capital: "Panaji",
  },
  gujarat: {
    name: "Gujarat",
    latitude: 23.2156,
    longitude: 72.6369,
    country: "India",
    capital: "Gandhinagar",
  },
  haryana: {
    name: "Haryana",
    latitude: 30.7333,
    longitude: 76.7794,
    country: "India",
    capital: "Chandigarh",
  },
  "himachal pradesh": {
    name: "Himachal Pradesh",
    latitude: 31.1048,
    longitude: 77.1734,
    country: "India",
    capital: "Shimla",
  },
  jharkhand: {
    name: "Jharkhand",
    latitude: 23.3441,
    longitude: 85.3096,
    country: "India",
    capital: "Ranchi",
  },
  karnataka: {
    name: "Karnataka",
    latitude: 12.9716,
    longitude: 77.5946,
    country: "India",
    capital: "Bengaluru",
  },
  kerala: {
    name: "Kerala",
    latitude: 8.5241,
    longitude: 76.9366,
    country: "India",
    capital: "Thiruvananthapuram",
  },
  "madhya pradesh": {
    name: "Madhya Pradesh",
    latitude: 23.2599,
    longitude: 77.4126,
    country: "India",
    capital: "Bhopal",
  },
  maharashtra: {
    name: "Maharashtra",
    latitude: 19.076,
    longitude: 72.8777,
    country: "India",
    capital: "Mumbai",
  },
  manipur: {
    name: "Manipur",
    latitude: 24.817,
    longitude: 93.9368,
    country: "India",
    capital: "Imphal",
  },
  meghalaya: {
    name: "Meghalaya",
    latitude: 25.5788,
    longitude: 91.8933,
    country: "India",
    capital: "Shillong",
  },
  mizoram: {
    name: "Mizoram",
    latitude: 23.7271,
    longitude: 92.7176,
    country: "India",
    capital: "Aizawl",
  },
  nagaland: {
    name: "Nagaland",
    latitude: 25.6747,
    longitude: 94.1086,
    country: "India",
    capital: "Kohima",
  },
  odisha: {
    name: "Odisha",
    latitude: 20.2961,
    longitude: 85.8245,
    country: "India",
    capital: "Bhubaneswar",
  },
  punjab: {
    name: "Punjab",
    latitude: 30.7333,
    longitude: 76.7794,
    country: "India",
    capital: "Chandigarh",
  },
  rajasthan: {
    name: "Rajasthan",
    latitude: 26.9124,
    longitude: 75.7873,
    country: "India",
    capital: "Jaipur",
  },
  sikkim: {
    name: "Sikkim",
    latitude: 27.3389,
    longitude: 88.6065,
    country: "India",
    capital: "Gangtok",
  },
  "tamil nadu": {
    name: "Tamil Nadu",
    latitude: 13.0827,
    longitude: 80.2707,
    country: "India",
    capital: "Chennai",
  },
  telangana: {
    name: "Telangana",
    latitude: 17.385,
    longitude: 78.4867,
    country: "India",
    capital: "Hyderabad",
  },
  tripura: {
    name: "Tripura",
    latitude: 23.8315,
    longitude: 91.2868,
    country: "India",
    capital: "Agartala",
  },
  "uttar pradesh": {
    name: "Uttar Pradesh",
    latitude: 26.8467,
    longitude: 80.9462,
    country: "India",
    capital: "Lucknow",
  },
  uttarakhand: {
    name: "Uttarakhand",
    latitude: 30.3165,
    longitude: 78.0322,
    country: "India",
    capital: "Dehradun",
  },
  "west bengal": {
    name: "West Bengal",
    latitude: 22.5726,
    longitude: 88.3639,
    country: "India",
    capital: "Kolkata",
  },
  // Union territories
  "andaman and nicobar islands": {
    name: "Andaman and Nicobar Islands",
    latitude: 11.6234,
    longitude: 92.7265,
    country: "India",
    capital: "Port Blair",
  },
  chandigarh: {
    name: "Chandigarh",
    latitude: 30.7333,
    longitude: 76.7794,
    country: "India",
    capital: "Chandigarh",
  },
  "dadra and nagar haveli and daman and diu": {
    name: "Dadra and Nagar Haveli and Daman and Diu",
    latitude: 20.4283,
    longitude: 72.8397,
    country: "India",
    capital: "Daman",
  },
  delhi: {
    name: "Delhi",
    latitude: 28.6139,
    longitude: 77.209,
    country: "India",
    capital: "New Delhi",
  },
  "jammu and kashmir": {
    name: "Jammu and Kashmir",
    latitude: 34.0837,
    longitude: 74.7973,
    country: "India",
    capital: "Srinagar (summer) · Jammu (winter)",
  },
  ladakh: {
    name: "Ladakh",
    latitude: 34.1526,
    longitude: 77.5771,
    country: "India",
    capital: "Leh",
  },
  lakshadweep: {
    name: "Lakshadweep",
    latitude: 10.5667,
    longitude: 72.6417,
    country: "India",
    capital: "Kavaratti",
  },
  puducherry: {
    name: "Puducherry",
    latitude: 11.9416,
    longitude: 79.8083,
    country: "India",
    capital: "Puducherry",
  },

  // United States — states & DC (capital coordinates)
  alabama: {
    name: "Alabama",
    latitude: 32.3777,
    longitude: -86.3006,
    country: "United States",
    capital: "Montgomery",
  },
  alaska: {
    name: "Alaska",
    latitude: 58.3019,
    longitude: -134.4197,
    country: "United States",
    capital: "Juneau",
  },
  arizona: {
    name: "Arizona",
    latitude: 33.4484,
    longitude: -112.074,
    country: "United States",
    capital: "Phoenix",
  },
  arkansas: {
    name: "Arkansas",
    latitude: 34.7465,
    longitude: -92.2896,
    country: "United States",
    capital: "Little Rock",
  },
  california: {
    name: "California",
    latitude: 38.5767,
    longitude: -121.4934,
    country: "United States",
    capital: "Sacramento",
  },
  colorado: {
    name: "Colorado",
    latitude: 39.7392,
    longitude: -104.9903,
    country: "United States",
    capital: "Denver",
  },
  connecticut: {
    name: "Connecticut",
    latitude: 41.7645,
    longitude: -72.6909,
    country: "United States",
    capital: "Hartford",
  },
  delaware: {
    name: "Delaware",
    latitude: 39.1573,
    longitude: -75.5197,
    country: "United States",
    capital: "Dover",
  },
  florida: {
    name: "Florida",
    latitude: 30.4383,
    longitude: -84.2807,
    country: "United States",
    capital: "Tallahassee",
  },
  georgia: {
    name: "Georgia",
    latitude: 33.749,
    longitude: -84.388,
    country: "United States",
    capital: "Atlanta",
  },
  hawaii: {
    name: "Hawaii",
    latitude: 21.307,
    longitude: -157.8574,
    country: "United States",
    capital: "Honolulu",
  },
  idaho: {
    name: "Idaho",
    latitude: 43.617,
    longitude: -116.2005,
    country: "United States",
    capital: "Boise",
  },
  illinois: {
    name: "Illinois",
    latitude: 39.7984,
    longitude: -89.6544,
    country: "United States",
    capital: "Springfield",
  },
  indiana: {
    name: "Indiana",
    latitude: 39.7684,
    longitude: -86.1581,
    country: "United States",
    capital: "Indianapolis",
  },
  iowa: {
    name: "Iowa",
    latitude: 41.5911,
    longitude: -93.6037,
    country: "United States",
    capital: "Des Moines",
  },
  kansas: {
    name: "Kansas",
    latitude: 39.0473,
    longitude: -95.6752,
    country: "United States",
    capital: "Topeka",
  },
  kentucky: {
    name: "Kentucky",
    latitude: 38.1867,
    longitude: -84.8753,
    country: "United States",
    capital: "Frankfort",
  },
  louisiana: {
    name: "Louisiana",
    latitude: 30.4515,
    longitude: -91.1871,
    country: "United States",
    capital: "Baton Rouge",
  },
  maine: {
    name: "Maine",
    latitude: 44.3072,
    longitude: -69.7818,
    country: "United States",
    capital: "Augusta",
  },
  maryland: {
    name: "Maryland",
    latitude: 38.9784,
    longitude: -76.4922,
    country: "United States",
    capital: "Annapolis",
  },
  massachusetts: {
    name: "Massachusetts",
    latitude: 42.3582,
    longitude: -71.0637,
    country: "United States",
    capital: "Boston",
  },
  michigan: {
    name: "Michigan",
    latitude: 42.7335,
    longitude: -84.5467,
    country: "United States",
    capital: "Lansing",
  },
  minnesota: {
    name: "Minnesota",
    latitude: 44.9551,
    longitude: -93.1022,
    country: "United States",
    capital: "Saint Paul",
  },
  mississippi: {
    name: "Mississippi",
    latitude: 32.3038,
    longitude: -90.1831,
    country: "United States",
    capital: "Jackson",
  },
  missouri: {
    name: "Missouri",
    latitude: 38.5792,
    longitude: -92.173,
    country: "United States",
    capital: "Jefferson City",
  },
  montana: {
    name: "Montana",
    latitude: 46.5857,
    longitude: -112.0184,
    country: "United States",
    capital: "Helena",
  },
  nebraska: {
    name: "Nebraska",
    latitude: 40.8089,
    longitude: -96.7078,
    country: "United States",
    capital: "Lincoln",
  },
  nevada: {
    name: "Nevada",
    latitude: 39.1638,
    longitude: -119.7674,
    country: "United States",
    capital: "Carson City",
  },
  "new hampshire": {
    name: "New Hampshire",
    latitude: 43.2069,
    longitude: -71.5376,
    country: "United States",
    capital: "Concord",
  },
  "new jersey": {
    name: "New Jersey",
    latitude: 40.2206,
    longitude: -74.7699,
    country: "United States",
    capital: "Trenton",
  },
  "new mexico": {
    name: "New Mexico",
    latitude: 35.6822,
    longitude: -105.9397,
    country: "United States",
    capital: "Santa Fe",
  },
  "new york": {
    name: "New York",
    latitude: 42.6526,
    longitude: -73.7562,
    country: "United States",
    capital: "Albany",
  },
  "north carolina": {
    name: "North Carolina",
    latitude: 35.7804,
    longitude: -78.6391,
    country: "United States",
    capital: "Raleigh",
  },
  "north dakota": {
    name: "North Dakota",
    latitude: 46.8208,
    longitude: -100.7837,
    country: "United States",
    capital: "Bismarck",
  },
  ohio: {
    name: "Ohio",
    latitude: 39.9623,
    longitude: -83.0007,
    country: "United States",
    capital: "Columbus",
  },
  oklahoma: {
    name: "Oklahoma",
    latitude: 35.4922,
    longitude: -97.5033,
    country: "United States",
    capital: "Oklahoma City",
  },
  oregon: {
    name: "Oregon",
    latitude: 44.9429,
    longitude: -123.0351,
    country: "United States",
    capital: "Salem",
  },
  pennsylvania: {
    name: "Pennsylvania",
    latitude: 40.2697,
    longitude: -76.8756,
    country: "United States",
    capital: "Harrisburg",
  },
  "rhode island": {
    name: "Rhode Island",
    latitude: 41.824,
    longitude: -71.4128,
    country: "United States",
    capital: "Providence",
  },
  "south carolina": {
    name: "South Carolina",
    latitude: 34.0007,
    longitude: -81.0348,
    country: "United States",
    capital: "Columbia",
  },
  "south dakota": {
    name: "South Dakota",
    latitude: 44.3668,
    longitude: -100.3538,
    country: "United States",
    capital: "Pierre",
  },
  tennessee: {
    name: "Tennessee",
    latitude: 36.1659,
    longitude: -86.7844,
    country: "United States",
    capital: "Nashville",
  },
  texas: {
    name: "Texas",
    latitude: 30.2747,
    longitude: -97.7404,
    country: "United States",
    capital: "Austin",
  },
  utah: {
    name: "Utah",
    latitude: 40.7776,
    longitude: -111.9311,
    country: "United States",
    capital: "Salt Lake City",
  },
  vermont: {
    name: "Vermont",
    latitude: 44.2627,
    longitude: -72.5754,
    country: "United States",
    capital: "Montpelier",
  },
  virginia: {
    name: "Virginia",
    latitude: 37.5389,
    longitude: -77.4336,
    country: "United States",
    capital: "Richmond",
  },
  washington: {
    name: "Washington",
    latitude: 47.0379,
    longitude: -122.9007,
    country: "United States",
    capital: "Olympia",
  },
  "west virginia": {
    name: "West Virginia",
    latitude: 38.3498,
    longitude: -81.6326,
    country: "United States",
    capital: "Charleston",
  },
  wisconsin: {
    name: "Wisconsin",
    latitude: 43.0747,
    longitude: -89.384,
    country: "United States",
    capital: "Madison",
  },
  wyoming: {
    name: "Wyoming",
    latitude: 41.1455,
    longitude: -104.802,
    country: "United States",
    capital: "Cheyenne",
  },
  "district of columbia": {
    name: "District of Columbia",
    latitude: 38.9072,
    longitude: -77.0369,
    country: "United States",
    capital: "Washington, D.C.",
  },
};

function queryVariants(normalized: string): string[] {
  const v = new Set<string>();
  v.add(normalized);
  v.add(normalized.replace(/\s+(state|province|region|territory)$/i, ""));
  v.add(normalized.replace(/^the\s+/i, ""));
  return [...v].filter((s) => s.length >= 2);
}

function isoFromCountryName(country: string): string | undefined {
  if (country === "India") return "in";
  if (country === "United States") return "us";
  return undefined;
}

function hitFromRow(key: string, row: RegionRow): GeocodeHit {
  const code = isoFromCountryName(row.country);
  return {
    id: syntheticId(`rf:${key}`),
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    country: row.country,
    admin1: row.name,
    feature_code: "ADM1",
    ...(code ? { country_code: code } : {}),
  };
}

/**
 * Returns synthetic geocode rows for known states/regions when the Open-Meteo
 * index does not list them as primary place names.
 */
export function matchRegionFallbacks(rawQuery: string): GeocodeHit[] {
  const n = normalizeQuery(rawQuery);
  if (n.length < 2) return [];

  for (const variant of queryVariants(n)) {
    const mapped = ALIASES[variant] ?? variant;
    const row = REGIONS[mapped];
    if (row) return [hitFromRow(mapped, row)];
  }
  return [];
}

export type RegionCapitalInfo = {
  regionName: string;
  capital: string;
  country: string;
};

/** When the primary place name is a state/UT/province in our table (e.g. Telangana, Texas). */
export function capitalForRegionPlaceName(
  placeName: string
): RegionCapitalInfo | null {
  const n = normalizeQuery(placeName);
  if (n.length < 2) return null;

  for (const variant of queryVariants(n)) {
    const mapped = ALIASES[variant] ?? variant;
    const row = REGIONS[mapped];
    if (row) {
      return {
        regionName: row.name,
        capital: row.capital,
        country: row.country,
      };
    }
  }
  return null;
}
