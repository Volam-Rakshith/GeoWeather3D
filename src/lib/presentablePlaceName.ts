/**
 * Geocoders often return place segments in ALL CAPS. Convert to title-style
 * words while leaving already mixed-case strings unchanged.
 */
export function presentablePlaceText(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const letters = t.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 2 || letters !== letters.toUpperCase()) return t;
  return t.replace(/\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
