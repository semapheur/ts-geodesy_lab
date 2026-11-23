import { coefLen, idx, MAXDEG, type GravityModel } from "./geodesy";

/** Metadata from a GeographicLib ".egm" (EGMF-1) text file. Everything is optional. */
export interface EgmMeta {
  name?: string;
  id?: string;
  GM?: number;
  R?: number;
  normalization?: string;
}

export function parseEgm(text: string): EgmMeta {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith("EGMF-1"))
    throw new Error("Not an EGMF-1 (.egm) file");
  const kv: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const m = line.match(/^([^#\s]\S*)\s+(.*?)\s*$/);
    if (m) kv[m[1]] = m[2];
  }
  const num = (s?: string) => (s === undefined ? undefined : parseFloat(s));
  return {
    name: kv.Name,
    id: kv.ID,
    GM: num(kv.ModelMass),
    R: num(kv.ModelRadius),
    normalization: (kv.Normalization ?? "full").toLowerCase(),
  };
}

/**
 * Parse a GeographicLib binary ".cof" file (little endian): 8-byte ID, int32 N, int32 M, cosine coefficients
 * C(n,m) ordered by order m then degree n, then sine coefficients S(n,m) in the same order for m ≥ 1, then an
 * optional correction series that is ignored. Coefficients are fully normalised (same as ICGEM).
 * `meta` (from the matching .egm file) supplies GM and the radius; without it EGM96/EGM2008 values are assumed.
 */
export function parseCof(
  buf: ArrayBuffer,
  meta: EgmMeta = {},
  maxDeg = MAXDEG,
  fallbackName = "COF model",
): GravityModel {
  if (buf.byteLength < 16) throw new Error("File too short for a .cof");
  const dv = new DataView(buf);
  const id = String.fromCharCode(...new Uint8Array(buf, 0, 8)).trim();
  if (meta.id && meta.id !== id)
    throw new Error(
      `ID mismatch: .cof has "${id}", .egm has "${meta.id}" (wrong file pair?)`,
    );
  if (meta.normalization && meta.normalization !== "full")
    throw new Error(`Unsupported normalization "${meta.normalization}"`);

  const N = dv.getInt32(8, true),
    M = dv.getInt32(12, true);
  if (N < 2 || M < 0 || M > N)
    throw new Error(`Bad .cof header (N=${N}, M=${M})`);
  const cCount = ((M + 1) * (2 * N - M + 2)) / 2; // Σ_{m=0..M} (N − m + 1)
  const sCount = cCount - (N + 1); // m = 0 is not stored for S
  if (buf.byteLength < 16 + 8 * (cCount + sCount))
    throw new Error(".cof file is truncated");

  const lim = Math.min(maxDeg, N, MAXDEG),
    len = coefLen(lim);
  const C = new Float32Array(len),
    S = new Float32Array(len);
  let off = 16;
  const read = (arr: Float32Array, m0: number) => {
    for (let m = m0; m <= M; m++) {
      if (m <= lim)
        for (let n = Math.max(m, 2); n <= lim; n++)
          arr[idx(n, m)] = dv.getFloat64(off + (n - m) * 8, true);
      off += (N - m + 1) * 8; // skip the rest of this column, including degrees above the limit
    }
  };
  read(C, 0);
  read(S, 1);

  const name = meta.name ?? fallbackName;
  return {
    id: `cof-${name}-${Date.now()}`,
    name: `${name} (n ≤ ${lim})`,
    GM: meta.GM ?? 3.986004415e14,
    R: meta.R ?? 6378136.3,
    maxDeg: lim,
    C,
    S,
  };
}
