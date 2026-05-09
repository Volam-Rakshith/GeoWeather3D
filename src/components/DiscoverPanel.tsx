import type { WikiCard } from "../api/wikipediaDiscover";
import type { RegionCapitalInfo } from "../lib/regionFallbacks";

export type DiscoverTab = "food" | "tourist";

type Props = {
  tab: DiscoverTab;
  onTabChange: (t: DiscoverTab) => void;
  regionCapital: RegionCapitalInfo | null;
  food: WikiCard | null;
  touristSpots: WikiCard[];
  loading: boolean;
  error: string | null;
};

export function DiscoverPanel({
  tab,
  onTabChange,
  regionCapital,
  food,
  touristSpots,
  loading,
  error,
}: Props) {
  return (
    <aside
      className="panel panel-left discover-panel"
      aria-label="Local discover"
      aria-busy={loading}
    >
      <div className="side-tabs" role="tablist" aria-label="Discover sections">
        <button
          type="button"
          role="tab"
          id="tab-food"
          aria-selected={tab === "food"}
          aria-controls="panel-food"
          className={tab === "food" ? "is-active" : ""}
          onClick={() => onTabChange("food")}
        >
          Famous food
        </button>
        <button
          type="button"
          role="tab"
          id="tab-tourist"
          aria-selected={tab === "tourist"}
          aria-controls="panel-tourist"
          className={tab === "tourist" ? "is-active" : ""}
          onClick={() => onTabChange("tourist")}
        >
          Tourist spots
        </button>
      </div>

      {regionCapital && (
        <div className="capital-strip" role="status">
          <strong className="capital-strip-value">{regionCapital.capital}</strong>
          <span className="capital-strip-meta">
            {regionCapital.regionName}
            {regionCapital.country &&
            regionCapital.country !== regionCapital.regionName
              ? ` · ${regionCapital.country}`
              : ""}
          </span>
        </div>
      )}

      <div className="discover-body">
        {loading && <span className="visually-hidden">Loading</span>}
        {error && !loading && <p className="discover-error">{error}</p>}

        {!loading && tab === "food" && (
          <div
            id="panel-food"
            role="tabpanel"
            aria-labelledby="tab-food"
            className="discover-scroll"
          >
            {food ? (
              <article className="wiki-card">
                <h3 className="wiki-card-title">
                  <a href={food.url} target="_blank" rel="noreferrer">
                    {food.title}
                  </a>
                </h3>
                <p className="wiki-card-extract">{food.extract}</p>
                {food.dishItems && food.dishItems.length > 0 && (
                  <div className="wiki-dish-block">
                    <h4 className="wiki-dish-heading">Foods &amp; dishes</h4>
                    <ul className="wiki-dish-list" role="list">
                      {food.dishItems.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ) : null}
          </div>
        )}

        {!loading && tab === "tourist" && (
          <div
            id="panel-tourist"
            role="tabpanel"
            aria-labelledby="tab-tourist"
            className="discover-scroll"
          >
            {touristSpots.length > 0 ? (
              <ul className="wiki-card-list">
                {touristSpots.map((p) => (
                  <li key={p.title}>
                    <article className="wiki-card wiki-card-compact">
                      <h3 className="wiki-card-title">
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title}
                        </a>
                      </h3>
                      <p className="wiki-card-extract">{p.extract}</p>
                    </article>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      <footer className="discover-foot">
        <a href="https://en.wikipedia.org" target="_blank" rel="noreferrer">
          Wikipedia
        </a>
      </footer>
    </aside>
  );
}
