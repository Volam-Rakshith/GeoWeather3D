import { Billboard, OrbitControls, Stars, useTexture } from "@react-three/drei";
import type { OrbitControls as StdOrbitControls } from "three-stdlib";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { threeSphereLocalFromLatLon } from "../lib/geo";

const EARTH_RADIUS = 2;
const WORLD_Y = new THREE.Vector3(0, 1, 0);

/** Sky dome distance — beyond star shells so sun/moon sit in deep space */
const CELESTIAL_DISTANCE = 205;

function celestialPosition(dir: THREE.Vector3): [number, number, number] {
  const v = dir.clone().normalize().multiplyScalar(CELESTIAL_DISTANCE);
  return [v.x, v.y, v.z];
}

/** Same axis as the main directional “sun” light */
const SUN_SKY_POS = celestialPosition(new THREE.Vector3(8, 6, 5));
/** Opposite side of the sky for night */
const MOON_SKY_POS = celestialPosition(new THREE.Vector3(-8, -6, -5));
/** Base idle rotation rate (rad/s); actual rate = this × `spinSpeedScale` */
const SPIN_SPEED_RAD_S = 0.021;
/** Default multiplier for the spin-speed slider (reset) */
export const DEFAULT_GLOBE_SPIN_SPEED_SCALE = 1;
/** Horizontal drag: radians per screen pixel (world Y spin) */
const DRAG_ROT_RAD_PER_PX = 0.004;

function projectOnPlane(
  vec: THREE.Vector3,
  planeNormalUnit: THREE.Vector3
): THREE.Vector3 {
  const n = planeNormalUnit.clone().normalize();
  return vec.clone().sub(n.multiplyScalar(vec.dot(n)));
}

/**
 * `setFromUnitVectors` alone picks an arbitrary roll around the view axis.
 * Rotate around the view direction so projected north matches camera up — stable "north-up" framing.
 */
function quaternionFacePointStableNorth(
  surfaceDirUnit: THREE.Vector3,
  towardCameraUnit: THREE.Vector3,
  cameraUpUnit: THREE.Vector3
): THREE.Quaternion {
  const v = surfaceDirUnit.clone().normalize();
  const camDir = towardCameraUnit.clone().normalize();

  const qAlign = new THREE.Quaternion().setFromUnitVectors(v, camDir);

  const northLocal = new THREE.Vector3(0, 1, 0);
  const northAfterAlign = northLocal.clone().applyQuaternion(qAlign);

  const twistAxis = camDir;
  const northInPlane = projectOnPlane(northAfterAlign, twistAxis);
  const upInPlane = projectOnPlane(cameraUpUnit, twistAxis);

  if (northInPlane.lengthSq() < 1e-10 || upInPlane.lengthSq() < 1e-10) {
    return qAlign;
  }

  northInPlane.normalize();
  upInPlane.normalize();

  const sin = twistAxis.dot(northInPlane.clone().cross(upInPlane));
  const cos = northInPlane.dot(upInPlane);
  const twistAngle = Math.atan2(sin, cos);
  const qTwist = new THREE.Quaternion().setFromAxisAngle(twistAxis, twistAngle);

  return new THREE.Quaternion().multiplyQuaternions(qTwist, qAlign);
}

/** Squared px movement above this counts as drag-spin vs a short press with no spin */
const POINTER_DRAG_THRESHOLD_SQ = 20 * 20;

export type AdminPinLevel = "country" | "state" | "city";

type FrameRequest = { lat: number; lon: number; id: number };

type EarthProps = {
  autoRotate: boolean;
  frameRequest: FrameRequest | null;
  dayMode: boolean;
  orbitControlsRef: RefObject<StdOrbitControls | null>;
  /** Multiplier for idle eastward spin when Globe spin is On (1 = default speed) */
  spinSpeedScale: number;
};

const SCENE = {
  day: {
    bg: "#152238",
    exposure: 1.58,
    hemiSky: "#d8e8ff",
    hemiGround: "#354568",
    hemiIntensity: 1.15,
    ambient: 0.58,
    ambientColor: "#e2e8ff",
    sunIntensity: 2.35,
    sunColor: "#fffaf4",
    fillIntensity: 0.95,
    fillColor: "#b4cffc",
    rimIntensity: 0.62,
    rimColor: "#ffffff",
    earthRoughness: 0.4,
    earthMetalness: 0.04,
    earthEmissive: "#000000",
    earthEmissiveIntensity: 0,
    haloColor: "#6bb6ff",
    haloOpacity: 0.14,
  },
  night: {
    bg: "#111d35",
    exposure: 1.08,
    hemiSky: "#3d5a80",
    hemiGround: "#121c30",
    hemiIntensity: 0.58,
    ambient: 0.38,
    ambientColor: "#b8cce8",
    sunIntensity: 0.68,
    sunColor: "#dceaff",
    fillIntensity: 0.42,
    fillColor: "#7a9fd4",
    rimIntensity: 0.28,
    rimColor: "#d4e4ff",
    earthRoughness: 0.52,
    earthMetalness: 0.03,
    earthEmissive: "#243552",
    earthEmissiveIntensity: 0.22,
    haloColor: "#4a7ec4",
    haloOpacity: 0.11,
  },
} as const;

function ExposureSync({ exposure }: { exposure: number }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMappingExposure = exposure;
  }, [gl, exposure]);
  return null;
}

/** Two additive layers: dense dim field + brighter cores for a visible glow in night mode */
function NightGlowStars() {
  return (
    <group>
      <Stars
        radius={132}
        depth={58}
        count={7500}
        factor={6.8}
        saturation={0.14}
        fade
        speed={0.32}
      />
      <Stars
        radius={118}
        depth={46}
        count={2400}
        factor={17}
        saturation={0.26}
        fade
        speed={0.48}
      />
    </group>
  );
}

const SUN_DISK_VERT = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SUN_DISK_FRAG = /* glsl */ `
varying vec2 vLocal;
uniform float uOuterR;
void main() {
  float d = length(vLocal);
  float r = d / uOuterR;
  if (r > 1.02) discard;

  // Normalized radius within the bright photosphere (limb at ~1)
  float diskR = d / (uOuterR * 0.42);
  float mu = sqrt(clamp(1.0 - min(diskR * diskR, 1.0), 0.0, 1.0));
  float limbDarken = mix(0.5, 1.0, pow(mu, 0.28));

  vec3 centerCol = vec3(1.0, 0.99, 0.94);
  vec3 midCol = vec3(1.0, 0.88, 0.52);
  vec3 limbCol = vec3(1.0, 0.48, 0.12);
  float tDisk = smoothstep(0.0, 0.18, diskR);
  vec3 photosphere = mix(centerCol, midCol, smoothstep(0.0, 0.45, diskR));
  photosphere = mix(photosphere, limbCol, smoothstep(0.35, 1.0, diskR));
  photosphere *= limbDarken;

  // Chromatic-ish corona (mostly warm, thin blue far wing)
  float g1 = exp(-r * 2.15) * 0.42;
  float g2 = exp(-r * 4.8) * 0.22;
  vec3 corona = vec3(1.0, 0.62, 0.28) * g1 + vec3(1.0, 0.85, 0.55) * g2;
  corona += vec3(0.75, 0.82, 1.0) * exp(-r * 6.5) * 0.06;
  float coronaMix = smoothstep(0.38, 1.0, r);
  vec3 rgb = photosphere + corona * coronaMix;

  float alpha = 1.0 - smoothstep(0.82, 1.0, r);
  alpha *= mix(1.0, 0.55, smoothstep(0.7, 1.0, r));
  gl_FragColor = vec4(rgb * alpha, alpha);
}
`;

const MOON_DISK_VERT = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_DISK_FRAG = /* glsl */ `
varying vec2 vLocal;
uniform float uRadius;
uniform vec3 uLightDir;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = vLocal / uRadius;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 N = normalize(vec3(p, z));
  vec3 L = normalize(uLightDir);
  float ndl = max(dot(N, L), 0.0);

  // Large basins (maria) + small crater noise
  float mare = smoothstep(0.42, 0.78, fbm(p * 1.7 + vec2(0.2, 0.8)));
  float cr = fbm(p * 9.0 + vec2(1.1, -0.4));
  float craters = smoothstep(0.72, 0.88, cr) * 0.22;

  vec3 highland = vec3(0.58, 0.57, 0.56);
  vec3 mareCol = vec3(0.38, 0.37, 0.39);
  vec3 albedo = mix(highland, mareCol, mare * 0.85);
  albedo *= 1.0 - craters;

  float wrap = pow(mix(0.12, 1.0, ndl), 0.62);
  vec3 lit = albedo * (0.07 + 1.05 * wrap);

  // Earthshine on the night side (slightly cool)
  float night = 1.0 - ndl;
  vec3 earthshine = albedo * night * night * vec3(0.12, 0.16, 0.22) * 1.35;

  vec3 rgb = lit + earthshine;
  float limbAlpha = 1.0 - smoothstep(0.92, 1.0, sqrt(r2));
  gl_FragColor = vec4(rgb, limbAlpha);
}
`;

const SUN_OUTER_R = 19;
const MOON_R = 9.2;

function SunBillboard() {
  const uniforms = useMemo(
    () => ({ uOuterR: { value: SUN_OUTER_R } }),
    []
  );
  return (
    <Billboard position={SUN_SKY_POS} follow>
      <mesh renderOrder={-20}>
        <circleGeometry args={[SUN_OUTER_R, 72]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={SUN_DISK_VERT}
          fragmentShader={SUN_DISK_FRAG}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.NormalBlending}
        />
      </mesh>
    </Billboard>
  );
}

function MoonBillboard() {
  /** Lit hemisphere biased toward upper-right of disc (sunward from Earth at night). */
  const uniforms = useMemo(
    () => ({
      uRadius: { value: MOON_R },
      uLightDir: { value: new THREE.Vector3(0.5, 0.22, 0.84).normalize() },
    }),
    []
  );
  return (
    <Billboard position={MOON_SKY_POS} follow>
      <mesh renderOrder={-20}>
        <circleGeometry args={[MOON_R, 72]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={MOON_DISK_VERT}
          fragmentShader={MOON_DISK_FRAG}
          transparent
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </Billboard>
  );
}

function CelestialBackdrop({ dayMode }: { dayMode: boolean }) {
  return dayMode ? <SunBillboard /> : <MoonBillboard />;
}

function Earth({
  autoRotate,
  frameRequest,
  dayMode,
  orbitControlsRef,
  spinSpeedScale,
}: EarthProps) {
  const { camera } = useThree();
  const spin = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const globeDragActiveRef = useRef(false);
  /** Pause automatic spin until this time (ms) after user drag or focus animation */
  const autoSpinPauseUntilRef = useRef(0);
  const autoRotateRef = useRef(autoRotate);
  const frameAnimRef = useRef<{
    q0: THREE.Quaternion;
    q1: THREE.Quaternion;
    start: number;
    duration: number;
  } | null>(null);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    if (!frameRequest) return;
    const { lat, lon } = frameRequest;
    let cancelled = false;
    let retries = 0;

    const run = () => {
      if (cancelled) return;
      const g = spin.current;
      if (!g) {
        if (retries++ < 90) requestAnimationFrame(run);
        return;
      }
      const v = threeSphereLocalFromLatLon(lat, lon, 1).normalize();
      const camDir = camera.position.clone().normalize();
      if (Math.abs(v.dot(camDir)) > 0.99995) return;

      const q1 = quaternionFacePointStableNorth(
        v,
        camDir,
        camera.up.clone().normalize()
      );
      frameAnimRef.current = {
        q0: g.quaternion.clone(),
        q1,
        start: performance.now(),
        duration: 900,
      };
    };

    requestAnimationFrame(run);
    return () => {
      cancelled = true;
    };
  }, [frameRequest, camera]);
  const normalMap = useTexture(
    "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/earth_normal_2048.jpg"
  );
  const colorMap = useTexture(
    "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/earth_atmos_2048.jpg"
  );

  const theme = dayMode ? SCENE.day : SCENE.night;

  useFrame((_, delta) => {
    const g = spin.current;
    if (!g) return;

    const anim = frameAnimRef.current;
    if (anim) {
      const t = Math.min(
        1,
        (performance.now() - anim.start) / anim.duration
      );
      const k = t * t * (3 - 2 * t);
      g.quaternion.slerpQuaternions(anim.q0, anim.q1, k);
      if (t >= 1) {
        frameAnimRef.current = null;
        autoSpinPauseUntilRef.current = performance.now() + 6500;
      }
      return;
    }

    if (performance.now() < autoSpinPauseUntilRef.current) return;

    if (autoRotateRef.current && !globeDragActiveRef.current) {
      g.rotateOnWorldAxis(
        WORLD_Y,
        SPIN_SPEED_RAD_S * spinSpeedScale * delta
      );
    }
  });

  useEffect(() => {
    const m = haloRef.current;
    if (!m) return;
    m.raycast = () => {};
  }, []);

  useEffect(
    () => () => {
      pointerCleanupRef.current?.();
    },
    []
  );

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    e.stopPropagation();

    pointerCleanupRef.current?.();

    const startX = e.nativeEvent.clientX;
    const startY = e.nativeEvent.clientY;
    const pointerId = e.pointerId;
    let lastMoveX = e.nativeEvent.clientX;

    const cleanup = () => {
      const didGlobeDrag = globeDragActiveRef.current;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      pointerCleanupRef.current = null;
      if (globeDragActiveRef.current && orbitControlsRef.current) {
        orbitControlsRef.current.enabled = true;
      }
      globeDragActiveRef.current = false;
      if (didGlobeDrag) {
        autoSpinPauseUntilRef.current = performance.now() + 5000;
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - lastMoveX;
      lastMoveX = ev.clientX;
      const distSq =
        (ev.clientX - startX) * (ev.clientX - startX) +
        (ev.clientY - startY) * (ev.clientY - startY);
      if (distSq <= POINTER_DRAG_THRESHOLD_SQ) return;

      const g = spin.current;
      if (!g) return;

      if (!globeDragActiveRef.current) {
        globeDragActiveRef.current = true;
        if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
      }
      g.rotateOnWorldAxis(WORLD_Y, dx * DRAG_ROT_RAD_PER_PX);
    };

    const onPointerEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };

    pointerCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
  };

  return (
    <group ref={spin}>
      <mesh onPointerDown={handlePointerDown}>
        <sphereGeometry args={[EARTH_RADIUS, 96, 96]} />
        <meshStandardMaterial
          map={colorMap}
          normalMap={normalMap}
          roughness={theme.earthRoughness}
          metalness={theme.earthMetalness}
          emissive={theme.earthEmissive}
          emissiveIntensity={theme.earthEmissiveIntensity}
        />
      </mesh>
      <mesh ref={haloRef}>
        <sphereGeometry args={[EARTH_RADIUS + 0.012, 64, 64]} />
        <meshBasicMaterial
          color={theme.haloColor}
          transparent
          opacity={theme.haloOpacity}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

type Props = {
  /** Continuous eastward rotation of the Earth mesh */
  autoRotate?: boolean;
  /** When id changes (after search pick), globe rotates to face this lat/lon toward the camera */
  frameRequest?: FrameRequest | null;
  /** Bright daylight scene vs darker night lighting */
  dayMode?: boolean;
  /** Multiplier for idle globe spin (1 = built-in default rad/s) */
  spinSpeedScale?: number;
};

export function GlobeScene({
  autoRotate = true,
  frameRequest = null,
  dayMode = true,
  spinSpeedScale = DEFAULT_GLOBE_SPIN_SPEED_SCALE,
}: Props) {
  const T = dayMode ? SCENE.day : SCENE.night;
  const orbitControlsRef = useRef<StdOrbitControls | null>(null);

  return (
    <Canvas
      camera={{ position: [0, 0.35, 6.2], fov: 45 }}
      gl={{
        antialias: true,
        alpha: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      onCreated={({ gl }) => {
        gl.toneMappingExposure = T.exposure;
      }}
      dpr={[1, 2]}
    >
      <ExposureSync exposure={T.exposure} />
      <color attach="background" args={[T.bg]} />
      <hemisphereLight
        args={[T.hemiSky, T.hemiGround, T.hemiIntensity]}
      />
      <ambientLight intensity={T.ambient} color={T.ambientColor} />
      <directionalLight
        position={[8, 6, 5]}
        intensity={T.sunIntensity}
        color={T.sunColor}
      />
      <directionalLight
        position={[-5, -1, -4]}
        intensity={T.fillIntensity}
        color={T.fillColor}
      />
      <directionalLight
        position={[0, 0, 10]}
        intensity={T.rimIntensity}
        color={T.rimColor}
      />
      <Suspense fallback={null}>
        <Earth
          autoRotate={autoRotate}
          frameRequest={frameRequest}
          dayMode={dayMode}
          orbitControlsRef={orbitControlsRef}
          spinSpeedScale={spinSpeedScale}
        />
        {!dayMode && <NightGlowStars />}
      </Suspense>
      <CelestialBackdrop dayMode={dayMode} />
      <OrbitControls
        ref={orbitControlsRef}
        enablePan={false}
        minDistance={3.2}
        maxDistance={10}
        rotateSpeed={0.55}
        zoomSpeed={0.65}
      />
    </Canvas>
  );
}
