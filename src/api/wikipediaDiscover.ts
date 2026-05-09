/**
 * Wikipedia (CC BY-SA) — no key, CORS-friendly for action & REST APIs.
 * Used for “famous” food & nearby tourist-spot intros for the selected map area.
 */

const W_API = "https://en.wikipedia.org/w/api.php";
const W_REST = "https://en.wikipedia.org/api/rest_v1/page/summary";

const W_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "GeoWether3D/1.0 (local weather/cuisine discover; +https://en.wikipedia.org/uses)",
};

export type WikiCard = {
  title: string;
  extract: string;
  url: string;
  /** Dish / food names parsed from the article (Wikitext list items & common subsection titles) */
  dishItems?: string[];
};

function slug(title: string): string {
  return encodeURIComponent(title.replace(/ /g, "_"));
}

async function fetchSummary(
  title: string,
  signal: AbortSignal
): Promise<WikiCard | null> {
  const url = `${W_REST}/${slug(title)}`;
  const res = await fetch(url, { signal, headers: W_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const j = (await res.json()) as {
    type?: string;
    title: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  if (j.type === "disambiguation" || !j.extract?.trim()) return null;
  const pageUrl =
    j.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug(j.title)}`;
  return { title: j.title, extract: j.extract.trim(), url: pageUrl };
}

/** First segment of label — skip raw coordinate labels */
export function primaryPlaceName(label: string): string | null {
  const t = label.trim().replace(/\s*·\s*locating.*$/i, "").trim();
  if (/^-?\d+\.\d+°\s*,/.test(t)) return null;
  const head = t.split(/[·,]/)[0].trim();
  if (!head || /^-?\d+\.\d+°$/.test(head)) return null;
  return head;
}

async function openSearchFirstCard(
  search: string,
  signal: AbortSignal
): Promise<WikiCard | null> {
  const params = new URLSearchParams({
    action: "opensearch",
    search,
    limit: "6",
    namespace: "0",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${W_API}?${params}`, { signal, headers: W_HEADERS });
  if (!res.ok) return null;
  const data = (await res.json()) as [string, string[]];
  const titles = data[1] ?? [];
  for (const t of titles) {
    if (/disambiguation/i.test(t)) continue;
    const card = await fetchSummary(t, signal);
    if (card && !/^This article is about/i.test(card.extract)) return card;
  }
  return null;
}

async function fetchParseWikitext(
  pageTitle: string,
  signal: AbortSignal
): Promise<string | null> {
  const params = new URLSearchParams({
    action: "parse",
    page: pageTitle,
    prop: "wikitext",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${W_API}?${params}`, { signal, headers: W_HEADERS });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    parse?: { wikitext?: { "*": string } | string };
    error?: { code?: string };
  };
  if (data.error || !data.parse?.wikitext) return null;
  const wt = data.parse.wikitext;
  return typeof wt === "string" ? wt : wt["*"] ?? null;
}

const SKIP_H2 =
  /\b(history|see\s+also|reference|external\s+link|further\s+reading|gallery|images?\b|notes|bibliography|safety|hygiene|nutrition)\b/i;

/**
 * Heavy nav / meta — not dish lists. Do NOT put “regional cuisine” here:
 * Italian/French/Mexican articles use that title for real chapters (we skip H3s there separately).
 */
const SKIP_H2_NAV_OR_REGION =
  /\b(by\s+state|states\s+and|union\s+territor|list\s+of.*\bstates\b|cuisine\s+by\s+region|geographic\s+distribution|government|economy|demographics)\b/i;

/** Headings that usually contain named dishes / ingredients (international EN Wikipedia) */
const KEEP_H2 =
  /\b(dishes?|foods?|food\b|bread|breads|rice\b|rice\s+dish|sweet|sweets|dessert|desserts|snack|snacks|starter|starters|course|courses|curry|curries|biryani|kebab|pickle|chutney|meal|meals?\b|meats?\b|vegetarian|non[- ]?vegetarian|seafood|soup|salads?\b|specialt(y|ies)|preparation|condiment|street\s+food|breakfast|lunch|dinner|traditional\s+(dishes|foods)|popular\s+(dishes|foods)|other\s+dishes|national|basic|elements?|ingredients?|components?|characteristics?|pasta|pizza|cheese|wine|beer|chocolate|maize|beans?|coffee|tea|drinks?|beverages|salumi|pastries|cakes?|pies?|noodles?|stews?|grilled|fried|tacos?|burritos?|holiday|festive|christmas|season|structure|overview|introduction|examples?|notable|famous|classic|typical|representative)\b/i;

/** Third pass: chapter looks food-related but wording differs by country */
const KEEP_H2_BROAD =
  /\b(dish|food|meal|cook|kitchen|eat|drink|bread|rice|meat|fish|fruit|vegetable|grain|spice|herb|sauce|sweet|dessert|snack|soup|salad|stew|curry|pasta|pizza|cheese|wine|beer|coffee|tea|chocolate|bean|maize|corn|egg|dairy|national|regional|traditional|basic|ingredient|element|special|beverage|breakfast|lunch|street|holiday|season|national\s+cuisine)\b/i;

function dishFriendlySectionTitleStrict(title: string): boolean {
  const t = title.trim();
  if (!t || SKIP_H2.test(t) || SKIP_H2_NAV_OR_REGION.test(t)) return false;
  if (KEEP_H2.test(t)) return true;
  return /\b(tea|coffee|lassi|sharbat|drink|beverage)\b/i.test(t) && t.length < 48;
}

/**
 * Second pass: article uses different wording (“Telangana cuisine”, “Common meals”).
 * Still reject nav lists; item-level filter drops states / territories.
 */
function dishFriendlySectionTitleRelaxed(title: string): boolean {
  const t = title.trim();
  if (!t || SKIP_H2.test(t) || SKIP_H2_NAV_OR_REGION.test(t)) return false;
  if (/^(Indian cuisine|Cuisine of India)$/i.test(t)) return false;
  if (KEEP_H2.test(t)) return true;
  return /\b(dish|dishes|food|foods|cooking|kitchen|bread|breads|rice|sweet|meal|meals|dessert|snack|starter|course|curry|biryani|kebab|pickle|chutney|soup|salad|beverage|tea|coffee|delicacy|delicacies|staple|spice|herbs?|ingredients?|preparation|condiment|breakfast|lunch|dinner|notable|famous|common|popular|cuisine|national|basic|elements?|pasta|pizza|wine|beer|chocolate|maize|beans?)\b/i.test(
    t
  );
}

function dishFriendlySectionTitleBroad(title: string): boolean {
  const t = title.trim();
  if (!t || SKIP_H2.test(t) || SKIP_H2_NAV_OR_REGION.test(t)) return false;
  if (/^(Indian cuisine|Cuisine of India)$/i.test(t)) return false;
  return KEEP_H2_BROAD.test(t);
}

/** Under “Regional cuisine(s)” H3s are usually places; bullets may still list dishes */
function shouldExtractH3ForSection(sectionTitle: string): boolean {
  return !/\bregional\s+cuisines?\b/i.test(sectionTitle.trim());
}

/**
 * Wikipedia “Indian cuisine”–style navboxes list states/UTs — not dishes.
 * Block those labels plus generic subsection titles.
 */
const GEO_ADMIN_BLOCKLIST = new Set(
  [
    "andaman and nicobar islands",
    "andhra pradesh",
    "arunachal pradesh",
    "assam",
    "west bengal",
    "bihar",
    "chandigarh",
    "chhattisgarh",
    "dadra and nagar haveli",
    "daman and diu",
    "delhi",
    "goa",
    "gujarat",
    "haryana",
    "himachal pradesh",
    "jammu and kashmir",
    "jharkhand",
    "karnataka",
    "kerala",
    "ladakh",
    "lakshadweep",
    "madhya pradesh",
    "maharashtra",
    "manipur",
    "meghalaya",
    "mizoram",
    "nagaland",
    "odisha",
    "orissa",
    "puducherry",
    "pondicherry",
    "punjab",
    "rajasthan",
    "sikkim",
    "sindh",
    "tamil nadu",
    "telangana",
    "tripura",
    "uttar pradesh",
    "uttarakhand",
    "non-alcoholic beverages",
    "alcoholic beverages",
  ].map((s) => s.toLowerCase())
);

/**
 * Bullets like “Naan”, “Sheermal”, “Murtabak” often appear in regional Indian
 * cuisine articles as pan-subcontinent staples — drop them for these titles.
 */
const DISH_PAN_EXACT_BLOCKLIST = new Set(
  [
    "naan",
    "sheermal",
    "murtabak",
    "mutabbaq",
    "chapati",
    "chapatti",
    "phulka",
    "kulcha",
    "tandoori roti",
    "rumali roti",
    "roomali roti",
    "rumali",
    "roomali",
    "roti",
    "firni",
    "phirni",
    "faluda",
    "falooda",
    "raita",
    "papad",
    "papadam",
    "papadum",
    "lassi",
    "chai",
    "tea",
    "coffee",
  ].map((s) => s.toLowerCase())
);

function cuisineArticleUsesRegionalIndianDishFilter(articleTitle: string): boolean {
  const at = articleTitle.toLowerCase();
  if (/^(indian cuisine|cuisine of india)$/i.test(articleTitle.trim())) return false;
  return /\b(hyderabadi|lucknowi|awadhi|deccani|chettinad|malabar|telangana|andhra|hyderabad|nizam|bengali|gujarati|goan|kashmiri|rajasthani|marathi|kerala|tamil|punjabi|bihari|assamese|odia|odiya|kolkata|mughlai|srilankan|nepali|bangladeshi|konkani|coorgi|dum\s+pukht|awadh)\b/i.test(
    at
  );
}

function dishLabelLooksPanRegionalNoise(
  articleTitle: string,
  dishLower: string
): boolean {
  if (!cuisineArticleUsesRegionalIndianDishFilter(articleTitle)) return false;

  if (DISH_PAN_EXACT_BLOCKLIST.has(dishLower)) return true;

  const namesLocalDish =
    /\b(hyderabadi|lucknowi|awadhi|deccani|telangana|nizam|kolkata|amritsar|malabar|chettinad|awadh|kashmiri|punjabi|bengali|goan|marathi|rajasthani|kolhapuri|madras|naga|old delhi|peshawari|mughlai)\b/i.test(
      dishLower
    );
  if (namesLocalDish) return false;

  if (
    /\b(naan|sheermal|murtabak|mutabbaq|rumali|roomali|chapati|chapatti|phulka|falooda|faluda|kulcha|tandoori roti|butter naan|garlic naan|cheese naan)\b/.test(
      dishLower
    )
  )
    return true;

  return false;
}

/** Trim Wikipedia “* [[X]] is a popular …” / “available at …” tail from list lines */
function simplifyDishListItemLabel(raw: string): string {
  let s = raw.trim();
  s = s.replace(
    /\s+(available at|available in|available with|usually sold|usually found|typically served|typically found|is a type of|is a kind of|is a popular|is an iconic|is a common|is a traditional|are a popular|are a type of|accompanied with|accompanied by)\b[\s\S]*$/i,
    ""
  );
  s = s.replace(/,\s*(usually|often|typically|commonly)\b[\s\S]*$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  const m = s.match(/^(.{2,72})\s*-\s+(.{10,})/);
  if (m && /\b(bread|pudding|derivative|similar|version|variant|style|topped)\b/i.test(m[2]))
    s = m[1].trim();
  return s.replace(/[.,;:]+$/, "").trim();
}

function shouldIncludeDishLabel(raw: string, articleTitle?: string): boolean {
  const t = raw.trim();
  if (t.length < 2 || t.length > 120) return false;
  const lower = t.toLowerCase().replace(/\s+/g, " ");

  if (GEO_ADMIN_BLOCKLIST.has(lower)) return false;

  if (articleTitle && dishLabelLooksPanRegionalNoise(articleTitle, lower))
    return false;

  if (/^(non[- ]?alcoholic|alcoholic)\s+beverages?$/.test(lower)) return false;
  if (/^beverages?$/.test(lower)) return false;

  /* Common Wikipedia geographic stubs mistaken for dishes */
  if (/\b(pradesh|nadu)\s*$/i.test(t) && t.length < 42) return false;

  /* Template / meta lines */
  if (/^\{\{/.test(raw) || /\}\}$/.test(raw)) return false;
  if (/^(category:|template:|file:)/i.test(lower)) return false;

  /* Long comma-heavy lines are usually “Region A, Region B, and Region C” nav */
  if (t.length > 52 && (t.match(/,/g) ?? []).length >= 3 && /\band\b/i.test(t))
    return false;

  return true;
}

function cleanWikiHeading(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/''+/g, "").trim();
}

function stripWikiMarkupOneLine(s: string): string {
  let x = s;
  x = x.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");
  x = x.replace(/\[\[([^\]]+)\]\]/g, "$1");
  x = x.replace(/\{\{[^}]+\}\}/g, " ");
  x = x.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "");
  x = x.replace(/<[^>]+>/g, "");
  x = x.replace(/''+/g, "");
  x = x.replace(/\s+/g, " ");
  return x.trim();
}

const SKIP_H3 =
  /\b(variant|variants|period|modern|medieval|gallery|images?\b|overview|introduction|see\s+also)\b/i;

function extractH3DishTitles(sectionBody: string, articleTitle: string): string[] {
  const out: string[] = [];
  const re = /^===\s*([^=\n]+?)\s*===\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sectionBody)) !== null) {
    const cleaned = cleanWikiHeading(m[1]);
    if (!cleaned || SKIP_H3.test(cleaned)) continue;
    if (cleaned.length > 90) continue;
    const line = stripWikiMarkupOneLine(cleaned);
    const simplified = simplifyDishListItemLabel(line);
    if (
      simplified &&
      shouldIncludeDishLabel(simplified, articleTitle)
    )
      out.push(simplified);
  }
  return out;
}

function parseListLineToItem(
  line: string,
  articleTitle: string
): string | null {
  if (/^\s*\{\{\s*main\s*\|/i.test(line)) return null;
  if (/^\[\[File:/i.test(line)) return null;
  let text = stripWikiMarkupOneLine(line);
  if (text.length < 2 || text.length > 160) return null;
  if (/^(see also|main article):/i.test(text)) return null;

  let head = text;
  const spacedDash = text.indexOf(" - ");
  if (spacedDash > 0) {
    head = text.slice(0, spacedDash).trim();
  } else {
    const tight = text.match(/^(.{2,72})\s*-\s*(.{8,})/);
    if (tight) head = tight[1].trim();
  }
  const paren = head.indexOf(" (");
  const rough = (
    paren > 0 ? head.slice(0, paren).trim() : head
  ).replace(/^[–—\-]\s*/, "");
  const item = simplifyDishListItemLabel(rough);
  if (item.length <= 1 || !shouldIncludeDishLabel(item, articleTitle))
    return null;
  return item;
}

function extractWikiBulletItems(
  sectionBody: string,
  articleTitle: string
): string[] {
  const out: string[] = [];
  for (const rawLine of sectionBody.split("\n")) {
    const m = rawLine.match(/^\*+\s*(.+)$/);
    if (!m) continue;
    const item = parseListLineToItem(m[1], articleTitle);
    if (item) out.push(item);
  }
  return out;
}

/** Numbered lists (#) — used on some cuisine pages */
function extractWikiNumberedItems(
  sectionBody: string,
  articleTitle: string
): string[] {
  const out: string[] = [];
  for (const rawLine of sectionBody.split("\n")) {
    const m = rawLine.match(/^#+\s*(.+)$/);
    if (!m) continue;
    const item = parseListLineToItem(m[1], articleTitle);
    if (item) out.push(item);
  }
  return out;
}

function splitLevel2Sections(wikitext: string): { title: string; body: string }[] {
  const re = /^==\s*([^=\n][^=\n]*?)\s*==\s*$/gm;
  const hits: { title: string; afterHeader: number; nextStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext)) !== null) {
    hits.push({
      title: cleanWikiHeading(m[1]),
      afterHeader: m.index + m[0].length,
      nextStart: m.index,
    });
  }
  const out: { title: string; body: string }[] = [];
  for (let i = 0; i < hits.length; i++) {
    const bodyEnd = i + 1 < hits.length ? hits[i + 1].nextStart : wikitext.length;
    out.push({
      title: hits[i].title,
      body: wikitext.slice(hits[i].afterHeader, bodyEnd),
    });
  }
  return out;
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const k = raw.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

async function fetchDishItemsForTitle(
  articleTitle: string,
  signal: AbortSignal
): Promise<string[]> {
  let wikitext: string | null;
  try {
    wikitext = await fetchParseWikitext(articleTitle, signal);
  } catch {
    return [];
  }
  if (!wikitext?.trim()) return [];

  const sections = splitLevel2Sections(wikitext);

  function gather(
    pickSection: (title: string) => boolean
  ): string[] {
    const collected: string[] = [];
    for (const { title, body } of sections) {
      if (!pickSection(title)) continue;
      collected.push(...extractWikiBulletItems(body, articleTitle));
      collected.push(...extractWikiNumberedItems(body, articleTitle));
      if (shouldExtractH3ForSection(title)) {
        collected.push(...extractH3DishTitles(body, articleTitle));
      }
    }
    return dedupePreserveOrder(collected);
  }

  const strict = gather(dishFriendlySectionTitleStrict);
  if (strict.length > 0) return strict.slice(0, 65);

  const relaxed = gather(dishFriendlySectionTitleRelaxed);
  if (relaxed.length > 0) return relaxed.slice(0, 65);

  const broad = gather(dishFriendlySectionTitleBroad);
  return broad.slice(0, 65);
}

export async function fetchFoodArticle(
  placeName: string,
  signal: AbortSignal
): Promise<WikiCard | null> {
  const q = placeName.trim();
  if (!q) return null;

  let card: WikiCard | null = null;

  const direct = [
    `${q} cuisine`,
    `Cuisine of ${q}`,
    `${q} food and drink`,
  ];
  for (const title of direct) {
    card = await fetchSummary(title, signal);
    if (card) break;
  }

  if (!card) {
    card = await openSearchFirstCard(`${q} cuisine`, signal);
  }
  if (!card) {
    card = await openSearchFirstCard(`${q} food`, signal);
  }
  if (!card) return null;

  const dishItems = await fetchDishItemsForTitle(card.title, signal);
  if (dishItems.length > 0) {
    return { ...card, dishItems };
  }
  return card;
}

/** Wikipedia geosearch allows gsradius only up to 10,000 m */
const GEO_RADIUS_MAX_M = 10000;

/** Prefer sights & visitor-oriented articles when ranking geosearch / search titles */
const TOURIST_TITLE_HINT =
  /\b(museums?|galler(y|ies)|cathedral|basilica|abbey|monastery|temple|mosque|synagogue|shrine|castle|palace|fort(ress)?|citadel|monument|memorial|tower|bridge|observator(y|ies)|planetarium|aquarium|zoo|national\s+park|world\s+heritage|UNESCO|amphitheat|ruins?|archaeolog|historic\s+(site|district|house|town)|landmarks?|viewpoint|lookout|scenic|waterfall|cave|lighthouse|beach|waterfront|promenade|plaza|piazza|square|arboretum|botanic|gardens?\b|cemetery|mausoleum|sanctuar(y|ies)|wildlife|visitor\s+cent(er|re)|tourist\s+attraction|sightseeing|destinations?\s+in\b|^Tourism\s+in\b|^List\s+of\b.*\b(attraction|landmark|museum|visitor|heritage|historic)\b|\b(state|city)\s+park\b|\bcanyon\b|\bvolcano\b|\bsummit\b)/i;

function titleLooksLikeTouristSpot(title: string): boolean {
  return TOURIST_TITLE_HINT.test(title);
}

function rankTitlesForTourism(titles: string[]): string[] {
  const tourist: string[] = [];
  const rest: string[] = [];
  for (const t of titles) {
    if (titleLooksLikeTouristSpot(t)) tourist.push(t);
    else rest.push(t);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...tourist, ...rest]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

async function openSearchTitles(
  search: string,
  limit: number,
  signal: AbortSignal
): Promise<string[]> {
  const params = new URLSearchParams({
    action: "opensearch",
    search,
    limit: String(limit),
    namespace: "0",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${W_API}?${params}`, { signal, headers: W_HEADERS });
  if (!res.ok) return [];
  const data = (await res.json()) as [string, string[]];
  return data[1] ?? [];
}

async function fetchNearbyTouristSpotCards(
  lat: number,
  lon: number,
  signal: AbortSignal
): Promise<WikiCard[]> {
  const params = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${lat}|${lon}`,
    gsradius: String(GEO_RADIUS_MAX_M),
    gslimit: "24",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${W_API}?${params}`, { signal, headers: W_HEADERS });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    error?: { code?: string };
    query?: { geosearch?: { title: string }[] };
  };
  if (data.error) return [];

  const raw = (data.query?.geosearch ?? []).map((g) => g.title);
  const titles = rankTitlesForTourism(raw);

  const cards: WikiCard[] = [];
  for (const title of titles) {
    if (/disambiguation/i.test(title)) continue;
    const c = await fetchSummary(title, signal);
    if (c && c.extract.length > 28) {
      cards.push(c);
    }
    if (cards.length >= 6) break;
  }
  return cards;
}

async function fetchTouristSpotsByNameFallback(
  placeName: string,
  signal: AbortSignal
): Promise<WikiCard[]> {
  const q = placeName.trim();
  if (!q) return [];

  const titleLists: string[][] = await Promise.all([
    openSearchTitles(`Tourism in ${q}`, 8, signal),
    openSearchTitles(`Visitor attractions in ${q}`, 8, signal),
    openSearchTitles(`${q} tourist attractions`, 8, signal),
    openSearchTitles(`List of tourist attractions in ${q}`, 6, signal),
    openSearchTitles(`${q} landmarks`, 6, signal),
    openSearchTitles(`${q} historic sites`, 6, signal),
    openSearchTitles(`${q} museums`, 6, signal),
  ]);

  const merged: string[] = [];
  for (const list of titleLists) {
    merged.push(...list);
  }
  const titles = rankTitlesForTourism(merged);

  const cards: WikiCard[] = [];
  for (const title of titles) {
    if (/disambiguation/i.test(title)) continue;
    const c = await fetchSummary(title, signal);
    if (c && c.extract.length > 28) {
      cards.push(c);
    }
    if (cards.length >= 6) break;
  }
  return cards;
}

export type DiscoverBundle = {
  food: WikiCard | null;
  touristSpots: WikiCard[];
};

export async function fetchDiscoverForPin(
  lat: number,
  lon: number,
  placeName: string | null,
  signal: AbortSignal
): Promise<DiscoverBundle> {
  const [food, spotsGeo] = await Promise.all([
    placeName ? fetchFoodArticle(placeName, signal) : Promise.resolve(null),
    fetchNearbyTouristSpotCards(lat, lon, signal),
  ]);

  let touristSpots = spotsGeo;
  if (touristSpots.length === 0 && placeName?.trim()) {
    touristSpots = await fetchTouristSpotsByNameFallback(placeName, signal);
  }

  return { food, touristSpots };
}
