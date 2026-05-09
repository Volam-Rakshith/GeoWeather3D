import * as THREE from "three";

/** Normalize degrees to (-180, 180] */
export function normalizeLongitudeDeg(lon: number): number {
  let l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === -180 ? 180 : l;
}

/**
 * Standard equirectangular / plate carrée UV (same as NASA-style textures):
 * u = 0 → 180°W, u = 0.5 → 0°, u = 1 → 180°E
 * v = 0 → 90°S, v = 1 → 90°N (Three.js SphereGeometry stores v=1 at north pole row)
 */
export function latLonFromPlateCarreeUv(uv: THREE.Vector2): {
  lat: number;
  lon: number;
} {
  const lon = normalizeLongitudeDeg(uv.x * 360 - 180);
  const lat = -90 + 180 * uv.y;
  return { lat, lon };
}

/**
 * Local surface point → WGS84 lat/lon (degrees).
 * Matches BufferGeometry from Three.js SphereGeometry (defaults).
 */
export function latLonFromThreeSphereLocal(p: THREE.Vector3): {
  lat: number;
  lon: number;
} {
  const R = p.length();
  if (R < 1e-8) return { lat: 0, lon: 0 };
  const x = p.x / R;
  const y = p.y / R;
  const z = p.z / R;

  const lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1)) * THREE.MathUtils.RAD2DEG;

  const phi = Math.atan2(z, -x);
  const lon = normalizeLongitudeDeg(phi * THREE.MathUtils.RAD2DEG - 180);

  return { lat, lon };
}

/** Geographic lat/lon → local point on Three.js default sphere (aligned with plate carrée texture) */
export function threeSphereLocalFromLatLon(
  lat: number,
  lon: number,
  radius: number
): THREE.Vector3 {
  const λ = lat * THREE.MathUtils.DEG2RAD;
  const θ = Math.PI / 2 - λ;
  const φ = ((lon + 180) / 360) * (2 * Math.PI);

  const x = -radius * Math.cos(φ) * Math.sin(θ);
  const y = radius * Math.cos(θ);
  const z = radius * Math.sin(φ) * Math.sin(θ);

  return new THREE.Vector3(x, y, z);
}
