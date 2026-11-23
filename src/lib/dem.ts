export interface DemSource {
  name: string;
  kind: "tiles" | "wms";
  url: string;
  layers: string;
  encoding: "terrarium" | "mapbox" | "gray";
  grayMin: number;
  grayMax: number;
  zoom: number;
}
export const DEM_W = 1024,
  DEM_H = 512;
export interface DemResult {
  data: Float32Array;
  min: number;
  max: number;
}

export const PRESET_DEMS: DemSource[] = [
  {
    name: "AWS Terrain Tiles (Terrarium)",
    kind: "tiles",
    url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    layers: "",
    encoding: "terrarium",
    grayMin: 0,
    grayMax: 0,
    zoom: 3,
  },
];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () =>
      rej(new Error(`Could not load ${url} (bad URL or missing CORS headers)`));
    i.src = url;
  });
}
const decode = (s: DemSource, r: number, g: number, b: number) =>
  s.encoding === "terrarium"
    ? r * 256 + g + b / 256 - 32768
    : s.encoding === "mapbox"
      ? -10000 + (r * 65536 + g * 256 + b) * 0.1
      : s.grayMin + (r / 255) * (s.grayMax - s.grayMin);

function pixels(
  w: number,
  h: number,
  draw: (c: CanvasRenderingContext2D) => void,
) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  draw(ctx);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Fetch a DEM and resample it to a 1024×512 equirectangular grid (row 0 = south). */
export async function loadDem(s: DemSource): Promise<DemResult> {
  const out = new Float32Array(DEM_W * DEM_H);
  let min = Infinity,
    max = -Infinity;
  const put = (x: number, y: number, v: number) => {
    out[(DEM_H - 1 - y) * DEM_W + x] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  };

  if (s.kind === "wms") {
    const sep = s.url.includes("?") ? "&" : "?";
    const url = `${s.url}${sep}SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${encodeURIComponent(s.layers)}&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=${DEM_W}&HEIGHT=${DEM_H}&FORMAT=image/png`;
    const img = await loadImage(url);
    const px = pixels(DEM_W, DEM_H, (c) =>
      c.drawImage(img, 0, 0, DEM_W, DEM_H),
    );
    for (let y = 0; y < DEM_H; y++)
      for (let x = 0; x < DEM_W; x++) {
        const k = (y * DEM_W + x) * 4;
        put(x, y, decode(s, px[k], px[k + 1], px[k + 2]));
      }
  } else {
    // XYZ or WMTS REST template in Web Mercator: {z}/{x}/{y} or {TileMatrix}/{TileCol}/{TileRow}
    const z = Math.min(Math.max(Math.round(s.zoom), 0), 4),
      n = 2 ** z,
      S = n * 256;
    const tiles = await Promise.all(
      Array.from({ length: n * n }, (_, i) => {
        const x = i % n,
          y = Math.floor(i / n);
        const url = s.url
          .replace(/\{(z|TileMatrix)\}/g, String(z))
          .replace(/\{(x|TileCol)\}/g, String(x))
          .replace(/\{(y|TileRow)\}/g, String(y));
        return loadImage(url).then((img) => ({ img, x, y }));
      }),
    );
    const px = pixels(S, S, (c) =>
      tiles.forEach((t) => c.drawImage(t.img, t.x * 256, t.y * 256)),
    );
    for (let y = 0; y < DEM_H; y++) {
      const lat =
        (Math.max(-85.05, Math.min(85.05, 90 - ((y + 0.5) / DEM_H) * 180)) *
          Math.PI) /
        180;
      const py = Math.min(
        S - 1,
        Math.floor(
          ((1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2) * S,
        ),
      );
      for (let x = 0; x < DEM_W; x++) {
        const k = (py * S + Math.floor(((x + 0.5) / DEM_W) * S)) * 4;
        put(x, y, decode(s, px[k], px[k + 1], px[k + 2]));
      }
    }
  }
  return { data: out, min, max };
}
