import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveSnapshot } from "./api/liveSnapshot";
import { fetchLiveSnapshot } from "./api/liveSnapshot";
import {
  describeLocalPeriod,
  describeWeatherCode,
  formatLocalWallClock,
  formatTimezoneShort,
  localHourFromIso,
  searchPlaces,
  windCompass,
  type GeocodeHit,
} from "./api/openMeteo";
import {
  formatPlaceLabel,
  normalizePlaceNames,
  resolveAdministrativePins,
  resolveFromGeocodeHit,
  type AdministrativePins,
  type LatLon,
  type PlaceNames,
} from "./api/nominatim";
import { presentablePlaceText } from "./lib/presentablePlaceName";
import {
  fetchDiscoverForPin,
  primaryPlaceName,
  type WikiCard,
} from "./api/wikipediaDiscover";
import { DiscoverPanel, type DiscoverTab } from "./components/DiscoverPanel";
import {
  DEFAULT_GLOBE_SPIN_SPEED_SCALE,
  GlobeScene,
  type AdminPinLevel,
} from "./components/GlobeScene";
import { resolveCapitalForDiscover } from "./api/capitals";
import {
  clampPinLevelToResolvedData,
  pinLevelFromGeocodeHit,
} from "./lib/geocodePinLevel";
import type { RegionCapitalInfo } from "./lib/regionFallbacks";

/** Globe spin UI: percent integer; internal scale = percent / 100 */
const MIN_SPIN_SPEED_PERCENT = 10;
const MAX_SPIN_SPEED_PERCENT = 100_000_000 * 100;

/** Deterministic sparkle layout for the intro cinematic (stable per mount). */
const CINE_SPARKLE_LAYOUT = Array.from({ length: 42 }, (_, i) => ({
  left: ((i * 37 + 11) % 86) + 7,
  top: ((i * 53 + 19) % 78) + 11,
  delay: i * 0.052,
  scale: 0.45 + (i % 9) * 0.085,
}));

/** Sparkle layout for the search panel VR-style chrome (stable per mount). */
const SEARCH_VR_SPARKLES = Array.from({ length: 10 }, (_, i) => ({
  left: ((i * 41 + 9) % 82) + 9,
  top: ((i * 29 + 5) % 62) + 12,
  delay: i * 0.08,
  scale: 0.35 + (i % 6) * 0.11,
}));

/** ISO 3166-1 alpha-2 for flag assets (Open-Meteo sometimes uses edge cases). */
function normalizeFlagCode(code: string): string {
  const c = code.trim().toLowerCase();
  if (c === "uk") return "gb";
  if (c === "el") return "gr";
  return c;
}

function countryFlagImageUrls(code: string): string[] {
  const iso = normalizeFlagCode(code);
  const upper = iso.toUpperCase();
  return [
    `https://cdn.jsdelivr.net/npm/flag-icons@7.3.2/flags/4x3/${iso}.svg`,
    `https://flagcdn.com/w160/${iso}.png`,
    `https://flagsapi.com/${upper}/flat/64.png`,
  ];
}

function CountryFlashFlag({ code, alt }: { code: string; alt: string }) {
  const sources = useMemo(() => countryFlagImageUrls(code), [code]);
  const [srcIndex, setSrcIndex] = useState(0);
  const src = sources[Math.min(srcIndex, sources.length - 1)];

  return (
    <img
      className="country-search-flash-flag"
      src={src}
      width={140}
      height={105}
      alt={alt}
      role={alt === "" ? "presentation" : undefined}
      loading="eager"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() =>
        setSrcIndex((i) => (i + 1 < sources.length ? i + 1 : i))
      }
    />
  );
}

/** After moving the location, keep Country / State when that tier still applies. */
function preferredPinLevelAfterResolve(
  previous: AdminPinLevel,
  pins: AdministrativePins,
  names: PlaceNames
): AdminPinLevel {
  const hasCountry =
    Boolean(pins.country) || Boolean(names.country?.trim());
  const hasState =
    Boolean(pins.state) || Boolean(names.state?.trim());

  if (previous === "country") {
    return hasCountry ? "country" : "city";
  }
  if (previous === "state") {
    if (hasState) return "state";
    if (hasCountry) return "country";
    return "city";
  }
  return "city";
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function App() {
  const [placePins, setPlacePins] = useState<{
    country: LatLon | null;
    state: LatLon | null;
    city: LatLon | null;
  }>({ country: null, state: null, city: null });
  const [placeNames, setPlaceNames] = useState<PlaceNames>({
    country: null,
    state: null,
    city: null,
    countryCode: null,
  });
  const [activePinLevel, setActivePinLevel] = useState<AdminPinLevel>("city");
  const activePinLevelRef = useRef<AdminPinLevel>(activePinLevel);
  useEffect(() => {
    activePinLevelRef.current = activePinLevel;
  }, [activePinLevel]);
  const [geoResolving, setGeoResolving] = useState(false);
  const geoReqId = useRef(0);
  const geoAbortRef = useRef<AbortController | null>(null);
  /** Stops applying browser geolocation when the user picks a place from search. */
  const userGeoBootstrapCancelledRef = useRef(false);
  const bootstrapGeoAcRef = useRef<AbortController | null>(null);

  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");
  const debouncedQ = useDebouncedValue(query, 280);
  const [suggestions, setSuggestions] = useState<GeocodeHit[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [globeAutoRotate, setGlobeAutoRotate] = useState(true);
  const [globeSpinSpeedScale, setGlobeSpinSpeedScale] = useState(
    DEFAULT_GLOBE_SPIN_SPEED_SCALE
  );
  const [spinSpeedPercentEdit, setSpinSpeedPercentEdit] = useState<
    string | null
  >(null);
  const searchFrameSeq = useRef(0);
  const [countrySearchFlash, setCountrySearchFlash] = useState<{
    displayName: string;
    flagCode: string | null;
  } | null>(null);
  const countryFlashTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(
    null
  );

  useEffect(() => {
    return () => {
      if (countryFlashTimerRef.current != null) {
        window.clearTimeout(countryFlashTimerRef.current);
      }
    };
  }, []);
  const [globeFrameRequest, setGlobeFrameRequest] = useState<{
    lat: number;
    lon: number;
    id: number;
  } | null>(null);
  const [sceneDayMode, setSceneDayMode] = useState(true);
  const [discoverTab, setDiscoverTab] = useState<DiscoverTab>("food");
  const [discoverFood, setDiscoverFood] = useState<WikiCard | null>(null);
  const [discoverTouristSpots, setDiscoverTouristSpots] = useState<WikiCard[]>(
    [],
  );
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);
  const discoverReqId = useRef(0);

  const [introActive, setIntroActive] = useState(true);
  const [introLeaving, setIntroLeaving] = useState(false);
  const [introCreditVisible, setIntroCreditVisible] = useState(false);

  useEffect(() => {
    if (!introLeaving) return;
    const t = window.setTimeout(() => setIntroActive(false), 1100);
    return () => window.clearTimeout(t);
  }, [introLeaving]);

  useEffect(() => {
    if (!introCreditVisible) return;
    const t = window.setTimeout(() => setIntroLeaving(true), 4600);
    return () => window.clearTimeout(t);
  }, [introCreditVisible]);

  const onIntroCtaClick = useCallback(() => {
    if (!introCreditVisible) setIntroCreditVisible(true);
  }, [introCreditVisible]);

  const weatherCoords = useMemo(() => {
    const city = placePins.city;
    if (!city) return null;
    return placePins[activePinLevel] ?? city;
  }, [placePins, activePinLevel]);

  /** Label in "Selected" row — scoped to Country / State / City focus, not always full locality chain */
  const selectedLocationLabel = useMemo(() => {
    if (!placePins.city) {
      return "Search above for a place";
    }
    if (geoResolving) return label;
    if (activePinLevel === "country") {
      if (placeNames.country?.trim()) return placeNames.country.trim();
      return formatPlaceLabel(placeNames);
    }
    if (activePinLevel === "state") {
      const st = placeNames.state?.trim();
      const co = placeNames.country?.trim();
      if (st && co) return `${st} · ${co}`;
      if (st) return st;
      if (co) return co;
      return formatPlaceLabel(placeNames);
    }
    return formatPlaceLabel(placeNames);
  }, [geoResolving, label, activePinLevel, placeNames, placePins.city]);

  /** Wikipedia / Discover primary query — matches focus level */
  const discoverFoodQuery = useMemo(() => {
    if (geoResolving) return null;
    if (activePinLevel === "country") {
      const c = placeNames.country?.trim();
      if (c) return c;
      if (placeNames.detailLine?.trim()) {
        const head = placeNames.detailLine.split(",")[0]?.trim();
        if (head) return head;
      }
      return null;
    }
    if (activePinLevel === "state") {
      const st = placeNames.state?.trim();
      const co = placeNames.country?.trim();
      if (st && co) return `${st}, ${co}`;
      return st ?? co ?? null;
    }
    const fromLabel = primaryPlaceName(label);
    if (fromLabel) return fromLabel;
    if (placeNames.city?.trim()) return placeNames.city.trim();
    if (placeNames.detailLine?.trim()) {
      const head = placeNames.detailLine.split(",")[0]?.trim();
      if (head) return head;
    }
    if (placeNames.state?.trim()) return placeNames.state.trim();
    return null;
  }, [
    geoResolving,
    activePinLevel,
    placeNames.country,
    placeNames.state,
    placeNames.city,
    placeNames.detailLine,
    label,
  ]);

  const [capitalInfo, setCapitalInfo] = useState<RegionCapitalInfo | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setCapitalInfo(null);
    void (async () => {
      try {
        const info = await resolveCapitalForDiscover(
          activePinLevel,
          placeNames,
          ac.signal
        );
        if (!ac.signal.aborted) setCapitalInfo(info);
      } catch {
        if (!ac.signal.aborted) setCapitalInfo(null);
      }
    })();
    return () => ac.abort();
  }, [
    activePinLevel,
    placeNames.country,
    placeNames.state,
    placeNames.countryCode,
  ]);

  const flagSrc = placeNames.countryCode
    ? `https://flagcdn.com/w80/${placeNames.countryCode}.png`
    : null;

  const loadLive = useCallback(
    async (lat: number, lon: number, background = false) => {
      if (!background) {
        setLoading(true);
        setErr(null);
      }
      try {
        const s = await fetchLiveSnapshot(lat, lon);
        setLive(s);
        if (!background) setErr(null);
      } catch {
        if (!background) {
          setErr("Couldn't load weather.");
          setLive(null);
        }
      } finally {
        if (!background) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!weatherCoords) return;
    loadLive(weatherCoords.lat, weatherCoords.lon);
  }, [weatherCoords, loadLive]);

  useEffect(() => {
    if (!weatherCoords) return;
    const t = window.setInterval(() => {
      loadLive(weatherCoords.lat, weatherCoords.lon, true);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [weatherCoords, loadLive]);

  /** On first open, use browser location + Nominatim to pre-fill the pin (unless user searches first). */
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    const ac = new AbortController();
    bootstrapGeoAcRef.current = ac;

    const apply = (lat: number, lon: number) => {
      void (async () => {
        if (ac.signal.aborted || userGeoBootstrapCancelledRef.current) return;
        try {
          const r = await resolveAdministrativePins(lat, lon, ac.signal);
          if (ac.signal.aborted || userGeoBootstrapCancelledRef.current) return;
          const names = normalizePlaceNames(r.names);
          setPlacePins(r.pins);
          setPlaceNames(names);
          setLabel(formatPlaceLabel(names));
          setActivePinLevel(
            preferredPinLevelAfterResolve(
              activePinLevelRef.current,
              r.pins,
              names
            )
          );
          searchFrameSeq.current += 1;
          setGlobeFrameRequest({
            lat: r.pins.city.lat,
            lon: r.pins.city.lon,
            id: searchFrameSeq.current,
          });
        } catch (e: unknown) {
          const aborted =
            e instanceof DOMException && e.name === "AbortError";
          if (!aborted && !ac.signal.aborted) {
            /* leave empty — no network or Nominatim error */
          }
        }
      })();
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (ac.signal.aborted) return;
        apply(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        if (bootstrapGeoAcRef.current === ac) bootstrapGeoAcRef.current = null;
      },
      {
        enableHighAccuracy: false,
        maximumAge: 300_000,
        timeout: 15_000,
      }
    );

    return () => {
      ac.abort();
      if (bootstrapGeoAcRef.current === ac) bootstrapGeoAcRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (geoResolving) return;
    const hasCountryName = Boolean(placeNames.country?.trim());
    const hasStateName = Boolean(placeNames.state?.trim());
    if (activePinLevel === "country" && !placePins.country && !hasCountryName) {
      setActivePinLevel("city");
    }
    if (activePinLevel === "state" && !placePins.state && !hasStateName) {
      setActivePinLevel("city");
    }
  }, [
    activePinLevel,
    placePins.country,
    placePins.state,
    placeNames.country,
    placeNames.state,
    geoResolving,
  ]);

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      if (!debouncedQ.trim()) {
        setSuggestions([]);
        setSearchPending(false);
        return;
      }

      setSearchPending(true);
      try {
        const r = await searchPlaces(debouncedQ, ac.signal);
        setSuggestions(r);
      } catch (e: unknown) {
        const aborted =
          (e instanceof DOMException || e instanceof Error) &&
          e.name === "AbortError";
        if (aborted) return;
        setSuggestions([]);
      } finally {
        setSearchPending(false);
      }
    })();

    return () => ac.abort();
  }, [debouncedQ]);

  useEffect(() => {
    if (!placePins.city) {
      setDiscoverFood(null);
      setDiscoverTouristSpots([]);
      setDiscoverErr(null);
      setDiscoverLoading(false);
      return;
    }
    const myId = ++discoverReqId.current;
    const ac = new AbortController();

    setDiscoverLoading(true);
    setDiscoverErr(null);

    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const bundle = await fetchDiscoverForPin(
            placePins.city!.lat,
            placePins.city!.lon,
            discoverFoodQuery,
            ac.signal
          );
          if (myId !== discoverReqId.current) return;
          setDiscoverFood(bundle.food);
          setDiscoverTouristSpots(bundle.touristSpots);
        } catch (e: unknown) {
          if (myId !== discoverReqId.current) return;
          const aborted =
            (e instanceof DOMException || e instanceof Error) &&
            e.name === "AbortError";
          if (aborted) return;
          setDiscoverErr("Couldn't load summaries.");
          setDiscoverFood(null);
          setDiscoverTouristSpots([]);
        } finally {
          if (myId === discoverReqId.current) setDiscoverLoading(false);
        }
      })();
    }, 320);

    return () => {
      ac.abort();
      window.clearTimeout(t);
      discoverReqId.current += 1;
    };
  }, [placePins.city, discoverFoodQuery]);

  const stepGlobeSpinPercent = useCallback(
    (delta: number) => {
      let base: number;
      if (
        spinSpeedPercentEdit !== null &&
        spinSpeedPercentEdit !== ""
      ) {
        const n = parseInt(spinSpeedPercentEdit, 10);
        base = Number.isFinite(n)
          ? n
          : Math.round(globeSpinSpeedScale * 100);
      } else {
        base = Math.round(globeSpinSpeedScale * 100);
      }
      const next = Math.min(
        MAX_SPIN_SPEED_PERCENT,
        Math.max(MIN_SPIN_SPEED_PERCENT, base + delta)
      );
      setGlobeSpinSpeedScale(next / 100);
      setSpinSpeedPercentEdit(null);
    },
    [spinSpeedPercentEdit, globeSpinSpeedScale]
  );

  const pickPlace = (p: GeocodeHit) => {
    const previousLevel = activePinLevelRef.current;
    userGeoBootstrapCancelledRef.current = true;
    bootstrapGeoAcRef.current?.abort();
    bootstrapGeoAcRef.current = null;
    if (countryFlashTimerRef.current != null) {
      window.clearTimeout(countryFlashTimerRef.current);
      countryFlashTimerRef.current = null;
    }
    geoAbortRef.current?.abort();
    const ac = new AbortController();
    geoAbortRef.current = ac;
    const id = ++geoReqId.current;
    setGeoResolving(true);
    setPlacePins({
      country: null,
      state: null,
      city: { lat: p.latitude, lon: p.longitude },
    });
    const quickNames = normalizePlaceNames({
      city: p.name,
      state: p.admin1 ?? null,
      country: p.country ?? null,
      countryCode: p.country_code?.trim().toLowerCase() ?? null,
    });
    setPlaceNames(quickNames);
    setLabel(formatPlaceLabel(quickNames));
    setQuery("");
    setSuggestions([]);
    setSearchPending(false);
    searchFrameSeq.current += 1;
    setGlobeFrameRequest({
      lat: p.latitude,
      lon: p.longitude,
      id: searchFrameSeq.current,
    });

    if (pinLevelFromGeocodeHit(p) === "country") {
      const displayName = presentablePlaceText(
        p.country?.trim() ? p.country : p.name
      );
      const rawCode = p.country_code?.trim();
      const flagCode = rawCode ? normalizeFlagCode(rawCode) : null;
      setCountrySearchFlash({ displayName, flagCode });
      countryFlashTimerRef.current = window.setTimeout(() => {
        setCountrySearchFlash(null);
        countryFlashTimerRef.current = null;
      }, 2000);
    } else {
      setCountrySearchFlash(null);
    }

    void (async () => {
      try {
        const r = await resolveFromGeocodeHit(p, ac.signal);
        if (id !== geoReqId.current) return;
        const names = normalizePlaceNames(r.names);
        setPlacePins(r.pins);
        setPlaceNames(names);
        setLabel(formatPlaceLabel(names));
        const inferred = pinLevelFromGeocodeHit(p);
        setActivePinLevel(
          inferred != null
            ? clampPinLevelToResolvedData(inferred, r.pins, names)
            : preferredPinLevelAfterResolve(previousLevel, r.pins, names)
        );
      } catch (e: unknown) {
        if (id !== geoReqId.current) return;
        const aborted =
          e instanceof DOMException && e.name === "AbortError";
        if (aborted) return;
      } finally {
        if (id === geoReqId.current) setGeoResolving(false);
      }
    })();
  };

  const weather = live?.weather;

  const wxLine = useMemo(() => {
    if (!weather) return null;
    return describeWeatherCode(weather.weatherCode);
  }, [weather]);

  const localPeriod = useMemo(() => {
    if (!weather?.localTimeIso) return null;
    const h = localHourFromIso(weather.localTimeIso);
    return describeLocalPeriod(h);
  }, [weather]);

  const uvCaption = (uv: number | null) => {
    if (uv == null) return "—";
    return uv.toFixed(1);
  };

  const mm = (v: number | null) =>
    v == null ? "—" : v < 0.05 ? "0" : v.toFixed(1);

  const µ = (v: number | null, digits = 1) =>
    v == null ? "—" : v.toFixed(digits);

  return (
    <div className={`app${sceneDayMode ? "" : " app--night"}`}>
      {introActive && (
        <div
          className={`intro-overlay${introLeaving ? " intro-overlay--out" : ""}${
            introCreditVisible
              ? " intro-overlay--cinematic"
              : " intro-overlay--welcome"
          }`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={
            introCreditVisible ? "intro-credit-heading" : "intro-title"
          }
          onTransitionEnd={(e) => {
            if (
              e.target === e.currentTarget &&
              e.propertyName === "opacity" &&
              introLeaving
            ) {
              setIntroActive(false);
            }
          }}
        >
          {!introCreditVisible ? (
            <>
              <div className="intro-backdrop" aria-hidden />
              <div className="intro-mesh" aria-hidden />
              <div className="intro-beams" aria-hidden />
              <div className="intro-orb intro-orb--a" aria-hidden />
              <div className="intro-orb intro-orb--b" aria-hidden />
              <div className="intro-sparkles" aria-hidden />
              <div className="intro-rings" aria-hidden>
                <span className="intro-ring intro-ring--1" />
                <span className="intro-ring intro-ring--2" />
                <span className="intro-ring intro-ring--3" />
              </div>
              <div className="intro-circle-waves" aria-hidden>
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="intro-circle-wave"
                    style={
                      { "--wave-i": i } as React.CSSProperties
                    }
                  />
                ))}
              </div>
              <div className="intro-glow" aria-hidden />
              <div className="intro-floaties" aria-hidden>
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <i
                    key={i}
                    className="intro-dot"
                    style={{ "--i": i } as React.CSSProperties}
                  />
                ))}
              </div>
              <div className="intro-shimmer" aria-hidden />
              <div className="intro-stars" aria-hidden>
                {[0, 1, 2, 3, 4].map((s) => (
                  <span
                    key={s}
                    className="intro-star"
                    style={{ "--s": s } as React.CSSProperties}
                  />
                ))}
              </div>
              <div className="intro-welcome-depth" aria-hidden>
                <span className="intro-depth-horizon" />
                <span className="intro-depth-grid" />
                <span className="intro-depth-flare" />
              </div>
              <div
                className={`intro-stage${introLeaving ? " intro-stage--out" : ""}`}
              >
                <div className="intro-title-wrap">
                  <h1 id="intro-title" className="intro-title">
                    GeoWether<span className="intro-title-3d">3D</span>
                  </h1>
                </div>
                <p className="intro-desc">
                  Live weather on a 3D globe — use the search above to pick a
                  place for conditions, local time, and curated Wikipedia
                  highlights.
                </p>
                <button
                  type="button"
                  className="intro-cta"
                  onClick={onIntroCtaClick}
                >
                  Enter the experience
                </button>
              </div>
            </>
          ) : (
            <div
              className={`intro-cinematic${
                introLeaving ? " intro-cinematic--out" : ""
              }`}
              aria-live="polite"
            >
              <div className="cine-jitter-layer">
                <div className="cine-bg-fx" aria-hidden>
                  <span className="cine-orb cine-orb--1" />
                  <span className="cine-orb cine-orb--2" />
                  <span className="cine-orb cine-orb--3" />
                  <span className="cine-sweep" />
                  <span className="cine-shockwave" />
                </div>
                <div className="cine-light-sweep" aria-hidden />
                <div className="cine-glitch-lines" aria-hidden>
                  <span className="cine-glitch-line cine-glitch-line--a" />
                  <span className="cine-glitch-line cine-glitch-line--b" />
                  <span className="cine-glitch-line cine-glitch-line--c" />
                </div>
                <div className="cine-grain" aria-hidden />
                <div className="cine-scan" aria-hidden />
                <div className="cine-noise-rgb" aria-hidden />
                <div className="cine-vignette" aria-hidden />
                <div className="cine-flash" aria-hidden />
                <div className="cine-lens-pack" aria-hidden>
                  <span className="cine-lens-glow" />
                  <span className="cine-lens-ring" />
                  <span className="cine-lens-streak" />
                  <span className="cine-lens-hex" />
                </div>
                <div className="cine-particles" aria-hidden>
                  {CINE_SPARKLE_LAYOUT.map((s, i) => (
                    <i
                      key={i}
                      className="cine-dot"
                      style={
                        {
                          "--x": `${s.left}%`,
                          "--y": `${s.top}%`,
                          "--sd": `${s.delay}s`,
                          "--ss": s.scale,
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </div>
                <div className="cine-chroma-pulse" aria-hidden />
                <div className="cine-bars" aria-hidden>
                  <span className="cine-bar cine-bar--top" />
                  <span className="cine-bar cine-bar--bottom" />
                </div>
                <div className="cine-content-stack">
                  <div className="cine-bloom" aria-hidden />
                  <div className="cine-content">
                    <p
                      className="cine-type cine-type--sm"
                      style={{ "--d": "0.2s" } as React.CSSProperties}
                    >
                      Presented by
                    </p>
                    <p
                      className="cine-type cine-type--vr"
                      style={{ "--d": "0.65s" } as React.CSSProperties}
                    >
                      VR!
                    </p>
                    <h2
                      id="intro-credit-heading"
                      className="cine-type cine-type--lg"
                      style={{ "--d": "1.15s" } as React.CSSProperties}
                    >
                      Immersive Earth experience
                    </h2>
                    <p
                      className="cine-type cine-type--md cine-type--product"
                      style={{ "--d": "1.65s" } as React.CSSProperties}
                    >
                      {["A", "product", "of", "VR", "developments"].map(
                        (w, i) => (
                          <span
                            key={`${w}-${i}`}
                            className="cine-word"
                            style={{ "--w": i } as React.CSSProperties}
                          >
                            {w}
                          </span>
                        ),
                      )}
                    </p>
                    <p
                      className="cine-type cine-type--by"
                      style={{ "--d": "2.35s" } as React.CSSProperties}
                    >
                      <span className="cine-by-label">by</span>{" "}
                      <span className="cine-by-name">Rakshith</span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {countrySearchFlash && (
        <div
          className="country-search-flash"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="country-search-flash-stack">
            <div className="country-flash-bg-fx" aria-hidden>
              <span className="country-flash-orb country-flash-orb--1" />
              <span className="country-flash-orb country-flash-orb--2" />
              <span className="country-flash-orb country-flash-orb--3" />
              <span className="country-flash-sweep" />
              <span className="country-flash-shockwave" />
            </div>
            <div className="country-flash-light-sweep" aria-hidden />
            <div className="country-flash-glitch-lines" aria-hidden>
              <span className="country-flash-glitch country-flash-glitch--a" />
              <span className="country-flash-glitch country-flash-glitch--b" />
              <span className="country-flash-glitch country-flash-glitch--c" />
            </div>
            <div className="country-flash-grain" aria-hidden />
            <div className="country-flash-scan" aria-hidden />
            <div className="country-flash-noise-rgb" aria-hidden />
            <div className="country-flash-chroma-pulse" aria-hidden />
            <div className="country-flash-vignette" aria-hidden />
            <div className="country-flash-bars" aria-hidden>
              <span className="country-flash-bar country-flash-bar--top" />
              <span className="country-flash-bar country-flash-bar--bottom" />
            </div>
            <div className="country-search-flash-jitter">
              <div className="country-search-flash-card">
                <p className="country-search-flash-kicker">Searching</p>
                {countrySearchFlash.flagCode ? (
                  <CountryFlashFlag
                    code={countrySearchFlash.flagCode}
                    alt=""
                  />
                ) : (
                  <div
                    className="country-search-flash-flag country-search-flash-flag--placeholder"
                    aria-hidden
                  />
                )}
                <p className="country-search-flash-name">
                  {countrySearchFlash.displayName}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="globe-wrap">
        <div className="globe-canvas-slot">
          <GlobeScene
            autoRotate={globeAutoRotate}
            frameRequest={globeFrameRequest}
            dayMode={sceneDayMode}
            spinSpeedScale={globeSpinSpeedScale}
          />
        </div>
      </div>

      <div className="app-content">
      <header className="brand">
        {flagSrc && (
          <img
            className="brand-flag"
            src={flagSrc}
            width={56}
            height={42}
            alt={placeNames.country ? `Flag of ${placeNames.country}` : "Country flag"}
            loading="lazy"
            decoding="async"
          />
        )}
        <div className="brand-text">
          <span className="logo">GeoWether3D</span>
        </div>
      </header>

      <DiscoverPanel
        tab={discoverTab}
        onTabChange={setDiscoverTab}
        regionCapital={activePinLevel === "city" ? null : capitalInfo}
        food={discoverFood}
        touristSpots={discoverTouristSpots}
        loading={discoverLoading}
        error={discoverErr}
      />

      <aside className="panel weather-panel" aria-busy={loading}>
        <div className="globe-motion-bar" role="group" aria-label="Scene lighting">
          <span className="globe-motion-label">Scene</span>
          <div className="globe-motion-toggle">
            <button
              type="button"
              className={sceneDayMode ? "is-active" : ""}
              onClick={() => setSceneDayMode(true)}
              aria-pressed={sceneDayMode}
            >
              Day
            </button>
            <button
              type="button"
              className={!sceneDayMode ? "is-active" : ""}
              onClick={() => setSceneDayMode(false)}
              aria-pressed={!sceneDayMode}
            >
              Night
            </button>
          </div>
        </div>

        <div className="globe-motion-bar" role="group" aria-label="Globe rotation">
          <span className="globe-motion-label">Globe spin</span>
          <div className="globe-motion-toggle">
            <button
              type="button"
              className={globeAutoRotate ? "is-active" : ""}
              onClick={() => setGlobeAutoRotate(true)}
              aria-pressed={globeAutoRotate}
            >
              On
            </button>
            <button
              type="button"
              className={!globeAutoRotate ? "is-active" : ""}
              onClick={() => setGlobeAutoRotate(false)}
              aria-pressed={!globeAutoRotate}
            >
              Off
            </button>
          </div>
        </div>

        {globeAutoRotate && (
          <div
            className="globe-motion-bar pin-size-bar spin-speed-bar"
            role="group"
            aria-label="Globe spin speed"
          >
            <span className="globe-motion-label">Spin speed</span>
            <div className="spin-speed-input-wrap">
              <div className="spin-speed-field">
                <input
                  type="number"
                  inputMode="numeric"
                  className="spin-speed-input"
                  min={MIN_SPIN_SPEED_PERCENT}
                  max={MAX_SPIN_SPEED_PERCENT}
                  step={1}
                  value={
                    spinSpeedPercentEdit !== null
                      ? spinSpeedPercentEdit
                      : String(Math.round(globeSpinSpeedScale * 100))
                  }
                  onFocus={() =>
                    setSpinSpeedPercentEdit(
                      String(Math.round(globeSpinSpeedScale * 100))
                    )
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") {
                      setSpinSpeedPercentEdit("");
                      return;
                    }
                    setSpinSpeedPercentEdit(v.replace(/\D/g, ""));
                  }}
                  onBlur={() => {
                    const draft = spinSpeedPercentEdit;
                    setSpinSpeedPercentEdit(null);
                    if (draft === null || draft === "") return;
                    const n = parseInt(draft, 10);
                    if (!Number.isFinite(n)) return;
                    const pct = Math.min(
                      MAX_SPIN_SPEED_PERCENT,
                      Math.max(MIN_SPIN_SPEED_PERCENT, n)
                    );
                    setGlobeSpinSpeedScale(pct / 100);
                  }}
                  aria-label="Globe spin speed percent"
                />
                <div
                  className="spin-speed-nudge"
                  role="group"
                  aria-label="Adjust by one percent"
                >
                  <button
                    type="button"
                    className="spin-speed-nudge-btn"
                    onClick={() => stepGlobeSpinPercent(1)}
                    aria-label="Increase spin speed by 1%"
                  >
                    <span className="spin-speed-nudge-icon" aria-hidden>
                      ▲
                    </span>
                  </button>
                  <button
                    type="button"
                    className="spin-speed-nudge-btn"
                    onClick={() => stepGlobeSpinPercent(-1)}
                    aria-label="Decrease spin speed by 1%"
                  >
                    <span className="spin-speed-nudge-icon" aria-hidden>
                      ▼
                    </span>
                  </button>
                </div>
              </div>
              <span className="spin-speed-suffix">%</span>
            </div>
            <button
              type="button"
              className="spin-speed-reset"
              onClick={() => {
                setGlobeSpinSpeedScale(DEFAULT_GLOBE_SPIN_SPEED_SCALE);
                setSpinSpeedPercentEdit(null);
              }}
              title="Reset spin speed to default"
            >
              Reset
            </button>
          </div>
        )}

        <div
          className="panel-search"
          aria-busy={Boolean(searchPending && debouncedQ.trim())}
        >
          <div className="panel-search-field-wrap">
            <div className="search-vr-fx" aria-hidden>
              <div className="search-vr-bg">
                <span className="search-vr-orb search-vr-orb--1" />
                <span className="search-vr-orb search-vr-orb--2" />
                <span className="search-vr-orb search-vr-orb--3" />
                <span className="search-vr-sweep" />
              </div>
              <div className="search-vr-particles">
                {SEARCH_VR_SPARKLES.map((s, i) => (
                  <i
                    key={i}
                    className="search-vr-dot"
                    style={
                      {
                        "--x": `${s.left}%`,
                        "--y": `${s.top}%`,
                        "--sd": `${s.delay}s`,
                        "--ss": s.scale,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
              <div className="search-vr-vignette" />
            </div>
            <label className="field">
              <span>Search place</span>
              <input
                type="search"
                placeholder="City or region…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
          </div>

          {suggestions.length > 0 && (
            <ul className="suggest" role="listbox">
              {suggestions.map((p) => (
                <li
                  key={`${p.id}-${p.latitude.toFixed(4)}-${p.longitude.toFixed(4)}`}
                >
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickPlace(p)}
                    >
                      {presentablePlaceText(p.name)}
                      {p.admin1 ? ` — ${presentablePlaceText(p.admin1)}` : ""}
                      {p.country ? ` (${presentablePlaceText(p.country)})` : ""}
                    </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel-details">
        <div className="loc">
          <span className="loc-label">Selected</span>
          <strong>{selectedLocationLabel}</strong>
        </div>

        {err && <p className="error">{err}</p>}

        {weather && live && (
          <div className={`wx${loading ? " wx--loading" : ""}`}>
            <div className="temp-row">
              <span className="temp">{Math.round(weather.temperature)}°</span>
              <span className="unit">C</span>
            </div>
            <p className="wx-desc">{wxLine}</p>

            <div className="local-strip">
              <div className="local-clock">
                <span className="local-time">
                  {formatLocalWallClock(weather.localTimeIso)}
                </span>
                <span className="tz-pill">
                  {formatTimezoneShort(weather.timezone)}
                </span>
              </div>
              <p className="local-place-phase">
                <strong>{localPeriod}</strong>
              </p>
            </div>

            {live.partialWarnings.length > 0 && (
              <ul className="partial-warn">
                {live.partialWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <dl className="stats stats-dense">
              <div>
                <dt>Feels like</dt>
                <dd>{Math.round(weather.apparent)}°C</dd>
              </div>
              <div>
                <dt>Humidity</dt>
                <dd>{Math.round(weather.humidity)}%</dd>
              </div>
              <div>
                <dt>Wind</dt>
                <dd>{Math.round(weather.windKmh)} km/h</dd>
              </div>
              <div>
                <dt>Wind dir.</dt>
                <dd>{windCompass(weather.windDirectionDeg)}</dd>
              </div>
              <div>
                <dt>Gusts</dt>
                <dd>
                  {weather.windGustsKmh != null
                    ? `${Math.round(weather.windGustsKmh)} km/h`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>UV index</dt>
                <dd>{uvCaption(weather.uvIndex)}</dd>
              </div>
              <div>
                <dt>Cloud cover</dt>
                <dd>
                  {weather.cloudCoverPct != null
                    ? `${Math.round(weather.cloudCoverPct)}%`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Pressure</dt>
                <dd>
                  {weather.pressureHpa != null
                    ? `${Math.round(weather.pressureHpa)} hPa`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Precip (now)</dt>
                <dd>{mm(weather.precipitationMm)} mm</dd>
              </div>
              <div>
                <dt>Rain / showers</dt>
                <dd>
                  {mm(weather.rainMm)} / {mm(weather.showersMm)} mm
                </dd>
              </div>
            </dl>

            {live.air && (
              <>
                <h3 className="subheading">Air quality</h3>
                <dl className="stats stats-dense">
                  <div>
                    <dt>EU AQI</dt>
                    <dd>
                      {live.air.europeanAqi != null
                        ? String(live.air.europeanAqi)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>US AQI</dt>
                    <dd>
                      {live.air.usAqi != null ? String(live.air.usAqi) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>PM2.5</dt>
                    <dd>{µ(live.air.pm25)} µg/m³</dd>
                  </div>
                  <div>
                    <dt>PM10</dt>
                    <dd>{µ(live.air.pm10)} µg/m³</dd>
                  </div>
                  <div>
                    <dt>O₃</dt>
                    <dd>{µ(live.air.ozone)} µg/m³</dd>
                  </div>
                  <div>
                    <dt>NO₂</dt>
                    <dd>{µ(live.air.nitrogenDioxide)} µg/m³</dd>
                  </div>
                </dl>
              </>
            )}
          </div>
        )}

        </div>
      </aside>
      </div>
    </div>
  );
}
