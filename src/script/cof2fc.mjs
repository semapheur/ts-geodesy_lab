/* Convert a GeographicLib gravity model (binary .cof + text .egm) to an ICGEM .gfc file.

   node cof2gfc.mjs <model_egm.cof> <out.gfc> [maxDegree] [--egm model.egm]

   The .egm file is found automatically when it sits next to the .cof and follows the usual naming (egm84_egm.cof -> egm84.egm); otherwise pass it with --egm. It supplies GM and the reference radius.

   .cof layout (little endian): 8-byte ID, int32 N, int32 M, then the cosine coefficients C(n,m) ordered by order m and then degree n (m = 0..M, n = m..N), then the sine coefficients S(n,m) in the same order for m = 1..M, then int32 N, int32 M of an optional correction series (ignored; -1 when absent). Coefficients are fully normalised, the same convention as ICGEM .gfc files.
*/
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2),
  pos = [];
let egmPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--egm") egmPath = args[++i];
  else pos.push(args[i]);
}
const [cofPath, outPath, limArg] = pos;
if (!cofPath || !outPath) {
  console.error(
    "usage: node cof2gfc.mjs <model_egm.cof> <out.gfc> [maxDegree] [--egm model.egm]",
  );
  process.exit(1);
}
if (!egmPath) {
  const guess = cofPath.replace(/_egm\.cof$/i, ".egm");
  if (guess !== cofPath && fs.existsSync(guess)) egmPath = guess;
}

// ---- metadata (.egm)
const meta = {};
if (egmPath) {
  const lines = fs.readFileSync(egmPath, "latin1").split(/\r?\n/);
  if (!lines[0].startsWith("EGMF-1"))
    throw new Error(`${egmPath} is not an EGMF-1 file`);
  for (const line of lines.slice(1)) {
    const m = line.match(/^([^#\s]\S*)\s+(.*?)\s*$/);
    if (m) meta[m[1]] = m[2];
  }
  if ((meta.Normalization ?? "full").toLowerCase() !== "full")
    throw new Error(`Unsupported normalization: ${meta.Normalization}`);
} else {
  console.warn(
    "warning: no .egm file found; using GM = 3.986004415e14 and R = 6378136.3 (EGM96/EGM2008 values)",
  );
}
const GM = meta.ModelMass ? parseFloat(meta.ModelMass) : 3.986004415e14;
const R = meta.ModelRadius ? parseFloat(meta.ModelRadius) : 6378136.3;
const name = (
  meta.Name ?? path.basename(cofPath).replace(/(_egm)?\.cof$/i, "")
).replace(/\s+/g, "_");

// ---- coefficients (.cof)
const buf = fs.readFileSync(cofPath);
const id = buf.toString("latin1", 0, 8).trim();
if (meta.ID && meta.ID !== id)
  throw new Error(`ID mismatch: .cof has "${id}", .egm has "${meta.ID}"`);
const N = buf.readInt32LE(8),
  M = buf.readInt32LE(12);
if (N < 2 || M < 0 || M > N) throw new Error(`Bad header: N=${N}, M=${M}`);
const cCount = Array.from({ length: M + 1 }, (_, m) => N - m + 1).reduce(
  (a, b) => a + b,
  0,
);
const sCount = cCount - (N + 1);
if (buf.length < 16 + 8 * (cCount + sCount))
  throw new Error("File is too short for its header (truncated?)");

const lim = limArg ? Math.min(+limArg, N) : N;
const idx = (n, m) => (n * (n + 1)) / 2 + m;
const C = new Float64Array(idx(N, N) + 1),
  S = new Float64Array(idx(N, N) + 1);
let off = 16;
const read = (arr, m0) => {
  for (let m = m0; m <= M; m++)
    for (let n = m; n <= N; n++, off += 8)
      arr[idx(n, m)] = buf.readDoubleLE(off);
};
read(C, 0);
read(S, 1);
C[0] = 1; // ICGEM convention: C00 = 1 (the .cof stores 0)

// ---- write ICGEM
const f = (x) => x.toExponential(15);
const fd = fs.openSync(outPath, "w");
fs.writeSync(
  fd,
  [
    "begin_of_head ================================================",
    "product_type            gravity_field",
    `modelname               ${name}`,
    `earth_gravity_constant  ${GM.toExponential(10)}`,
    `radius                  ${R.toExponential(10)}`,
    `max_degree              ${lim}`,
    "errors                  no",
    "norm                    fully_normalized",
    "tide_system             unknown",
    "end_of_head ==================================================",
    "",
  ].join("\n"),
);
for (let n = 0; n <= lim; n++) {
  const rows = [];
  for (let m = 0; m <= n; m++)
    rows.push(
      `gfc ${String(n).padStart(4)} ${String(m).padStart(4)} ${f(C[idx(n, m)])} ${f(S[idx(n, m)])}`,
    );
  fs.writeSync(fd, rows.join("\n") + "\n");
}
fs.closeSync(fd);
console.log(`${name}: degree ${lim}, GM ${GM}, R ${R} -> ${outPath}`);
