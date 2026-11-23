// node gfc2bin.mjs EGM2008.gfc egm2008.f32 [maxDegree]
import fs from "node:fs";
import readline from "node:readline";

const [, , src, dst, limArg] = process.argv;
const lim = limArg ? +limArg : Infinity;
const num = (s) => parseFloat(s.replace(/[dD]/, "e"));

let GM = 3.986004415e14,
  R = 6378136.3,
  fileDeg = 0,
  N = 0,
  out = null;
const rl = readline.createInterface({
  input: fs.createReadStream(src),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const t = line.trim().split(/\s+/);
  if (!out) {
    // header
    if (t[0] === "earth_gravity_constant") GM = num(t[1]);
    else if (t[0] === "radius") R = num(t[1]);
    else if (t[0] === "max_degree") fileDeg = +t[1];
    else if (t[0] === "end_of_head") {
      N = Math.min(fileDeg, lim);
      out = new Float32Array((2 * ((N + 1) * (N + 2))) / 2); // C and S interleaved, sized by the real degree
    }
    continue;
  }
  if (t[0] !== "gfc") continue;
  const n = +t[1],
    m = +t[2];
  if (n > N) break; // bodies are sorted by degree
  const k = (n * (n + 1)) / 2 + m;
  out[2 * k] = num(t[3]);
  out[2 * k + 1] = num(t[4]);
}
rl.close();

const head = Buffer.alloc(24); // uint32 degree, 4 bytes padding, float64 GM, float64 radius
head.writeUInt32LE(N, 0);
head.writeDoubleLE(GM, 8);
head.writeDoubleLE(R, 16);
fs.writeFileSync(dst, Buffer.concat([head, Buffer.from(out.buffer)]));
console.log(`degree ${N}: ${(24 + out.byteLength) / 1e6} MB`);
