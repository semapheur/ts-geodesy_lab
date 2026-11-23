export interface RampDef {
  id: string;
  name: string;
  stops: string[];
} // sRGB hex stops, evenly spaced

export const RAMPS: RampDef[] = [
  {
    id: "geoid",
    name: "Geoid (blue → red)",
    stops: ["#1c1478", "#2e78d2", "#eef3ef", "#f2a33c", "#9e1230"],
  },
  {
    id: "viridis",
    name: "Viridis",
    stops: [
      "#440154",
      "#482878",
      "#3e4a89",
      "#31688e",
      "#26828e",
      "#1f9e89",
      "#35b779",
      "#6ece58",
      "#b5de2b",
      "#fde725",
    ],
  },
  {
    id: "plasma",
    name: "Plasma",
    stops: ["#0d0887", "#6a00a8", "#b12a90", "#e16462", "#fca636", "#f0f921"],
  },
  {
    id: "inferno",
    name: "Inferno",
    stops: ["#000004", "#420a68", "#932667", "#dd513a", "#fca50a", "#fcffa4"],
  },
  {
    id: "magma",
    name: "Magma",
    stops: ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"],
  },
  {
    id: "cividis",
    name: "Cividis (colour-blind safe)",
    stops: ["#00204d", "#31446b", "#666970", "#958f78", "#cbba69", "#ffe945"],
  },
  {
    id: "turbo",
    name: "Turbo",
    stops: [
      "#30123b",
      "#4662d7",
      "#36aaf9",
      "#1ae4b6",
      "#72fe5e",
      "#c7ef34",
      "#faba39",
      "#f66b19",
      "#cb2a04",
      "#7a0403",
    ],
  },
  {
    id: "coolwarm",
    name: "Cool–warm (diverging)",
    stops: ["#3b4cc0", "#8db0fe", "#dddddd", "#f4987a", "#b40426"],
  },
  { id: "greys", name: "Greyscale", stops: ["#000000", "#ffffff"] },
];

const hex = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];

function colorAt(
  rgb: [number, number, number][],
  t: number,
): [number, number, number] {
  const s = Math.min(Math.max(t, 0), 1) * (rgb.length - 1),
    i = Math.min(Math.floor(s), rgb.length - 2),
    f = s - i;
  return rgb[i].map((c, k) => c + (rgb[i + 1][k] - c) * f) as [
    number,
    number,
    number,
  ];
}

/** 256×1 RGBA8 lookup table (sRGB), used as a texture by the viewer. */
export function buildLut(def: RampDef, reverse = false, n = 256): Uint8Array {
  const rgb = def.stops.map(hex),
    lut = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = colorAt(rgb, reverse ? 1 - i / (n - 1) : i / (n - 1));
    lut.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4);
  }
  return lut;
}

/** t in 0..1 -> sRGB 0..255, for the 2D map. */
export function makeRamp(
  def: RampDef,
  reverse = false,
): (t: number) => [number, number, number] {
  const lut = buildLut(def, reverse);
  return (t) => {
    const i = Math.round(Math.min(Math.max(t, 0), 1) * 255) * 4;
    return [lut[i], lut[i + 1], lut[i + 2]];
  };
}

export const rampCss = (def: RampDef, reverse = false) =>
  `linear-gradient(90deg, ${(reverse ? [...def.stops].reverse() : def.stops).join(",")})`;
