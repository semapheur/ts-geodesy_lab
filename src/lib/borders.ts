export type Ring = [number, number][]; // [lon, lat] in degrees

/** Collect every polygon ring of a GeoJSON FeatureCollection (Polygon and MultiPolygon). */
export function extractRings(gj: any): Ring[] {
  const rings: Ring[] = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const polys =
      g.type === "Polygon"
        ? [g.coordinates]
        : g.type === "MultiPolygon"
          ? g.coordinates
          : [];
    for (const p of polys)
      for (const r of p)
        rings.push(r.map((c: number[]) => [c[0], c[1]] as [number, number]));
  }
  return rings;
}

export function project(
  lon: number,
  lat: number,
  proj: "equirect" | "mollweide",
  W: number,
  H: number,
): [number, number] {
  if (proj === "equirect")
    return [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
  const phi = (lat * Math.PI) / 180;
  let th = Math.sign(phi) * (Math.PI / 2);
  if (Math.abs(lat) < 89.99) {
    th = phi;
    for (let i = 0; i < 30; i++) {
      // Newton: 2θ + sin 2θ = π sin φ
      const d =
        (2 * th + Math.sin(2 * th) - Math.PI * Math.sin(phi)) /
        (2 + 2 * Math.cos(2 * th));
      th -= d;
      if (Math.abs(d) < 1e-7) break;
    }
  }
  return [
    (((lon / 180) * Math.cos(th) + 1) / 2) * W,
    ((1 - Math.sin(th)) / 2) * H,
  ];
}

export function drawBorders(
  ctx: CanvasRenderingContext2D,
  rings: Ring[],
  proj: "equirect" | "mollweide",
  W: number,
  H: number,
) {
  ctx.save();
  ctx.strokeStyle = "rgba(16,21,28,0.85)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (const r of rings)
    for (let i = 0; i < r.length; i++) {
      const [x, y] = project(r[i][0], r[i][1], proj, W, H);
      if (i === 0 || Math.abs(r[i][0] - r[i - 1][0]) > 180) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  ctx.stroke();
  ctx.restore();
}

export function drawMarker(
  ctx: CanvasRenderingContext2D,
  lat: number,
  lon: number,
  proj: "equirect" | "mollweide",
  W: number,
  H: number,
) {
  const [x, y] = project(lon, lat, proj, W, H);
  ctx.save();
  ctx.fillStyle = "#ff3b30";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
