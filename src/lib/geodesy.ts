export interface Ellipsoid {
  name: string;
  a: number;
  invF: number;
}
export const ELLIPSOIDS: Ellipsoid[] = [
  { name: "WGS 84", a: 6378137, invF: 298.257223563 },
  { name: "GRS 80 (ETRS89, NAD83)", a: 6378137, invF: 298.257222101 },
  { name: "WGS 72", a: 6378135, invF: 298.26 },
  { name: "International 1924 (ED50)", a: 6378388, invF: 297 },
  { name: "Bessel 1841", a: 6377397.155, invF: 299.1528128 },
  { name: "Clarke 1866 (NAD27)", a: 6378206.4, invF: 294.9786982 },
  { name: "Krassovsky 1940", a: 6378245, invF: 298.3 },
  { name: "Airy 1830", a: 6377563.396, invF: 299.3249646 },
];

export const MAXDEG = 2190; // EGM2008
export const coefLen = (deg: number) => ((deg + 1) * (deg + 2)) / 2;
export const CAP = coefLen(MAXDEG);
export const idx = (n: number, m: number) => (n * (n + 1)) / 2 + m;

const GM_NORMAL = 3.986004418e14,
  OMEGA = 7.292115e-5,
  G0 = 9.80665,
  A_WGS84 = 6378137;

/** Dynamic form factor J2 of the level ellipsoid (Heiskanen & Moritz). */
export function normalJ2(a: number, invF: number): number {
  const f = 1 / invF,
    b = a * (1 - f),
    e2 = f * (2 - f),
    ep = Math.sqrt(e2 / (1 - e2));
  const m = (OMEGA * OMEGA * a * a * b) / GM_NORMAL;
  const q0 = 0.5 * ((1 + 3 / (ep * ep)) * Math.atan(ep) - 3 / ep);
  return (e2 / 3) * (1 - (2 * m * ep) / (15 * q0));
}

/** Fully normalised spherical-harmonic gravity model (ICGEM convention). */
export interface GravityModel {
  id: string;
  name: string;
  GM: number;
  R: number;
  maxDeg: number;
  C: Float32Array;
  S: Float32Array;
}

function fromList(
  id: string,
  name: string,
  list: [number, number, number, number][],
  zonalOnly = false,
): GravityModel {
  const L = coefLen(Math.max(...list.map((e) => e[0])));
  const C = new Float32Array(L),
    S = new Float32Array(L);
  let maxDeg = 0;
  for (const [n, m, c, s] of list) {
    if (zonalOnly && m !== 0) continue;
    C[idx(n, m)] = c;
    S[idx(n, m)] = s;
    maxDeg = Math.max(maxDeg, n);
  }
  return { id, name, GM: 3.986004415e14, R: 6378136.3, maxDeg, C, S };
}

// Low-degree EGM96 coefficients, typed in from memory: verify against ICGEM before scientific use.
const EGM96_LOW: [number, number, number, number][] = [
  [2, 0, -4.84165371736e-4, 0],
  [2, 1, -1.86987635955e-10, 1.19528012031e-9],
  [2, 2, 2.43914352398e-6, -1.40016683654e-6],
  [3, 0, 9.57254173792e-7, 0],
  [3, 1, 2.03046201047e-6, 2.48513158716e-7],
  [3, 2, 9.04627768605e-7, -6.19025944205e-7],
  [3, 3, 7.21072657057e-7, 1.41435626958e-6],
  [4, 0, 5.39873863789e-7, 0],
  [4, 1, -5.36321616971e-7, -4.7344026585e-7],
  [4, 2, 3.50694105785e-7, 6.6267157254e-7],
  [4, 3, 9.90771803829e-7, -2.00928369177e-7],
  [4, 4, -1.88560802735e-7, 3.08853169333e-7],
  [5, 0, 6.8532347563e-8, 0],
  [6, 0, -1.49957994714e-7, 0],
];
export const BUILTIN_MODELS: GravityModel[] = [
  fromList("egm96-low", "EGM96 low degree (n ≤ 4, C50, C60)", EGM96_LOW),
  fromList("zonal", "Zonal terms only (C20 … C60)", EGM96_LOW, true),
];

const num = (s: string) => parseFloat(s.replace(/[dD]/, "e"));
const isPlain = (tok: string) => /^\d+$/.test(tok); // bare "n m C S" lines (e.g. NGA EGM84)

/** Line-by-line ICGEM parser shared by the string and the streaming entry points. */
function gfcParser(maxDeg: number) {
  const lim = Math.min(maxDeg, MAXDEG);
  const C = new Float32Array(coefLen(lim)),
    S = new Float32Array(coefLen(lim)); // sized by degree, not by MAXDEG
  let name = "ICGEM model",
    GM = 3.986004415e14,
    R = 6378136.3,
    top = 0;
  return {
    /** Feed one line. Returns false once the degree limit is passed: ICGEM bodies are sorted by degree. */
    feed(line: string): boolean {
      const t = line.trim().split(/\s+/);
      const k = t[0];
      if (k === "modelname") name = t[1];
      else if (k === "earth_gravity_constant") GM = num(t[1]);
      else if (k === "radius") R = num(t[1]);
      else if (k === "gfc" || k === "gfct" || isPlain(k)) {
        const o = isPlain(k) ? 0 : 1,
          n = +t[o],
          m = +t[o + 1];
        if (n > lim) return false;
        if (n >= 2 && m <= n) {
          C[idx(n, m)] = num(t[o + 2]);
          S[idx(n, m)] = num(t[o + 3]);
          top = Math.max(top, n);
        }
      }
      return true;
    },
    finish(): GravityModel {
      if (!top) throw new Error("No gfc coefficient lines found");
      return {
        id: `gfc-${name}-${Date.now()}`,
        name: `${name} (n ≤ ${top})`,
        GM,
        R,
        maxDeg: top,
        C,
        S,
      };
    },
  };
}

/** Parse ICGEM text that is already in memory. */
export function parseGfc(text: string, maxDeg = MAXDEG): GravityModel {
  const p = gfcParser(maxDeg);
  for (const line of text.split("\n")) if (!p.feed(line)) break;
  return p.finish();
}

/**
 * Parse an ICGEM file as a stream (File.stream() or fetch().body). Only one chunk plus a partial
 * line is held in memory, and reading stops as soon as the degree exceeds `maxDeg`, so a 250 MB
 * EGM2008 file is never fully loaded or even fully downloaded.
 */
export async function parseGfcStream(
  stream: ReadableStream<Uint8Array>,
  maxDeg = MAXDEG,
  onProgress?: (bytesRead: number) => void,
): Promise<GravityModel> {
  const p = gfcParser(maxDeg),
    reader = stream.getReader(),
    dec = new TextDecoder();
  let tail = "",
    bytes = 0,
    more = true;
  while (more) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    onProgress?.(bytes);
    const lines = (tail + dec.decode(value, { stream: true })).split("\n");
    tail = lines.pop()!; // last piece may be a partial line
    for (const l of lines)
      if (!p.feed(l)) {
        more = false;
        break;
      }
  }
  if (more && tail + dec.decode() !== "") p.feed(tail);
  await reader.cancel().catch(() => {}); // stop the download/read if we quit early
  return p.finish();
}

export function parseBin(
  buf: ArrayBuffer,
  name: string,
  maxDeg = MAXDEG,
): GravityModel {
  const dv = new DataView(buf);
  const fileDeg = dv.getUint32(0, true);
  const GM = dv.getFloat64(8, true),
    R = dv.getFloat64(16, true);
  const deg = Math.min(fileDeg, maxDeg, MAXDEG),
    len = coefLen(deg);
  const f = new Float32Array(buf, 24); // 24 is a multiple of 4, so this view is aligned
  const C = new Float32Array(len),
    S = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    C[i] = f[2 * i];
    S[i] = f[2 * i + 1];
  }
  return {
    id: `bin-${name}-${Date.now()}`,
    name: `${name} (n ≤ ${deg})`,
    GM,
    R,
    maxDeg: deg,
    C,
    S,
  };
}

export interface Prepared {
  c: Float32Array;
  s: Float32Array;
  deg: number;
  scale: number;
  n0: number;
}
/**
 * Geoid height by Bruns' formula, N = GM/(R·γ) · Σ (ΔC cos mλ + S sin mλ) P̄nm(sin φ),
 * where ΔC20 = C20(model) − C20(normal field of the chosen ellipsoid).
 * An ellipsoid with another semi-major axis shifts N by (a_WGS84 − a).
 */
export function prepare(m: GravityModel, e: Ellipsoid, deg: number): Prepared {
  const d = Math.max(2, Math.min(deg, m.maxDeg, MAXDEG));
  const c = new Float32Array(coefLen(d)),
    s = new Float32Array(coefLen(d));
  for (let n = 2; n <= d; n++)
    for (let k = 0; k <= n; k++) {
      c[idx(n, k)] = m.C[idx(n, k)];
      s[idx(n, k)] = m.S[idx(n, k)];
    }
  c[idx(2, 0)] += normalJ2(e.a, e.invF) / Math.sqrt(5); // C20 − (−J2/√5)
  return { c, s, deg: d, scale: m.GM / (m.R * G0), n0: A_WGS84 - e.a };
}
