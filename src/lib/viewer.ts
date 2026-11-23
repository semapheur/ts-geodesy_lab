import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  instanceIndex,
  instancedArray,
  storage,
  float,
  int,
  uniform,
  sin,
  cos,
  sqrt,
  asin,
  atan,
  exp2,
  abs,
  normalize,
  positionGeometry,
  positionView,
  mix,
  clamp,
  floor,
  min,
  select,
  vec2,
  vec3,
  vec4,
  texture,
  dFdx,
  dFdy,
  cross,
  varying,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RAMPS, buildLut } from "./ramp";
import { CAP, MAXDEG, type Prepared } from "./geodesy";
import { DEM_W, DEM_H } from "./dem";
import type { Ring } from "./borders";
import type { Show } from "./types";

export const GW_MAX = 4096,
  GH_MAX = 2048; // largest global grid (≈0.088°, resolves degree ~2048)
const BASE_DEG = 512; // with tiling, the global layer is computed only up to this degree
const TILE_MAX = 1024; // largest tile edge in cells
const CHUNK = 1 << 19; // threads per Legendre dispatch (long jobs are split into many submissions)
const BATCH = 1 << 20; // complex samples per FFT batch (rows × gw)
const PI = Math.PI;
const TWO32 = 4294967296; // 2^64 is built as TWO32·TWO32 because TSL cannot print 1.8e19 as a WGSL literal
const two64 = () => float(TWO32).mul(TWO32);
const inv64 = () => float(1).div(two64());
const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(n));
/** Longitude samples for a degree: a power of two ≥ 2·degree (FFT size), 1024…4096. */
const gridSize = (deg: number) =>
  Math.min(GW_MAX, Math.max(1024, nextPow2(2 * deg)));

/** Parallels and meridians as unit direction vectors (lon/lat -> sphere); the line material displaces them. */
function graticulePositions(step = 15, seg = 2): Float32Array {
  const pos: number[] = [];
  const push = (lon: number, lat: number) => {
    const l = (lon * PI) / 180,
      p = (lat * PI) / 180;
    pos.push(
      Math.cos(p) * Math.cos(l),
      Math.sin(p),
      -Math.cos(p) * Math.sin(l),
    );
  };
  const line = (pts: [number, number][]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      push(...pts[i]);
      push(...pts[i + 1]);
    }
  };
  for (let lon = -180; lon < 180; lon += step) {
    const pts: [number, number][] = [];
    for (let lat = -90; lat <= 90; lat += seg) pts.push([lon, lat]);
    line(pts);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const pts: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += seg) pts.push([lon, lat]);
    line(pts);
  }
  return new Float32Array(pos);
}

export interface LatLon {
  lat: number;
  lon: number;
} // degrees
export interface GeoidGrid {
  data: Float32Array;
  w: number;
  h: number;
} // row 0 = south, cell centres
export interface Extreme extends LatLon {
  value: number;
} // metres, geoid − ellipsoid
export interface Extremes {
  min: Extreme;
  max: Extreme;
}
export interface SolveOptions {
  tiling?: boolean;
  onProgress?: (fraction: number) => void;
}
interface Tile {
  data: Float32Array;
  w: number;
  h: number;
  i0: number;
  j0: number;
  gwT: number;
}

export class Viewer {
  renderer: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  controls: OrbitControls;
  wire: THREE.Mesh;
  demTex: THREE.DataTexture;
  rampTex: THREE.DataTexture; // 256×1 colour lookup table

  /** Render-side uniforms. Grid dims change only when a finished result is published, never mid-compute. */
  U = {
    a: uniform(6378137),
    e2: uniform(0.00669438),
    exag: uniform(1e4),
    lo: uniform(-100),
    hi: uniform(100),
    layer: uniform(0),
    relief: uniform(1),
    field: uniform(1),
    ref: uniform(0),
    gw: uniform(1024, "int"),
    gh: uniform(512, "int"), // base grid
    tgw: uniform(4096, "int"),
    tgh: uniform(2048, "int"),
    ti0: uniform(0, "int"),
    tj0: uniform(0, "int"),
    tw: uniform(2, "int"),
    th: uniform(2, "int"),
    tOn: uniform(0), // detail tile
  };
  /** Compute-side uniforms (describe the job that is currently running). */
  private C = {
    maxDeg: uniform(36, "int"),
    stride: uniform(37, "int"),
    gw: uniform(1024, "int"),
    gh: uniform(512, "int"),
    rowBase: uniform(0, "int"),
    nrows: uniform(0, "int"),
    off: uniform(0, "int"),
    fr0: uniform(0, "int"),
    rows: uniform(0, "int"),
    fn: uniform(2, "int"),
    fs: uniform(1, "int"),
    fin: uniform(0),
    scale: uniform(0),
    n0: uniform(0),
    tj0: uniform(0, "int"),
    ti0: uniform(0, "int"),
    tw: uniform(1, "int"),
  };
  // TSL node graphs are loosely typed on purpose
  private cBuf: any = instancedArray(new Float32Array(CAP), "float");
  private sBuf: any = instancedArray(new Float32Array(CAP), "float");
  private aE: any = instancedArray(TILE_MAX * (MAXDEG + 1), "float"); // even (n−m) part of Σ ΔC·P̄nm, per computed row and order m
  private aO: any = instancedArray(TILE_MAX * (MAXDEG + 1), "float"); // odd part
  private bE: any = instancedArray(TILE_MAX * (MAXDEG + 1), "float"); // same for S
  private bO: any = instancedArray(TILE_MAX * (MAXDEG + 1), "float");
  private xr: any = instancedArray(BATCH, "float");
  private xi: any = instancedArray(BATCH, "float"); // FFT ping
  private yr: any = instancedArray(BATCH, "float");
  private yi: any = instancedArray(BATCH, "float"); // FFT pong
  private out: any = instancedArray(GW_MAX * GH_MAX, "float");
  private tileOut: any = instancedArray(TILE_MAX * TILE_MAX, "float");
  private passLegendre: any;
  private passFill: any;
  private stageXY: any;
  private stageYX: any;
  private storeGlobal: any;
  private storeTile: any;

  private ro: ResizeObserver;
  private lineMat: THREE.LineBasicNodeMaterial;
  private borderLines?: THREE.LineSegments;
  private bordersOn = true;
  private ref = 0;

  // picking
  onHover?: (p: LatLon | null) => void;
  onPick?: (p: LatLon | null) => void;
  onTile?: (message: string) => void;
  onExtremes?: (e: Extremes | null) => void;
  private grat: THREE.LineSegments;
  private extMin: THREE.Mesh;
  private extMax: THREE.Mesh;
  private ext: Extremes | null = null;
  private extremesOn = false;
  private geo: GeoidGrid | null = null;
  private tile: Tile | null = null;
  private demGrid: Float32Array | null = null;
  private pickLL: LatLon | null = null;
  private marker: THREE.Mesh;
  private ray = new THREE.Raycaster();

  // job control: a newer base solve (gen) or tile request (tileGen) aborts older work at its next dispatch
  private gen = 0;
  private tileGen = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private prep: Prepared | null = null;
  private tilingOn = false;
  private tileTimer: ReturnType<typeof setTimeout> | undefined;

  static async create(host: HTMLElement) {
    const r = new THREE.WebGPURenderer({ antialias: true });
    await r.init();
    return new Viewer(r, host);
  }

  private constructor(renderer: THREE.WebGPURenderer, host: HTMLElement) {
    this.renderer = renderer;
    renderer.setPixelRatio(devicePixelRatio);
    host.appendChild(renderer.domElement);
    this.scene.background = new THREE.Color(0x0b1016);
    this.camera.position.set(0, 0.9, 3.2);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.3;
    this.controls.maxDistance = 8;
    this.controls.addEventListener("end", () => this.scheduleTile(400));

    const { U, out } = this;
    this.buildCompute();

    this.demTex = new THREE.DataTexture(
      new Float32Array(DEM_W * DEM_H),
      DEM_W,
      DEM_H,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.demTex.magFilter = this.demTex.minFilter = THREE.NearestFilter;
    this.demTex.needsUpdate = true;

    // ---- height lookup from a unit direction: bilinear in the base grid, blended with the detail tile, or the DEM
    const roOut = storage(out.value, "float", GW_MAX * GH_MAX).toReadOnly();
    const roTile = storage(
      this.tileOut.value,
      "float",
      TILE_MAX * TILE_MAX,
    ).toReadOnly();
    const gwF = float(U.gw),
      ghF = float(U.gh);
    const heightAt = (d: any) => {
      const u = atan(d.z.negate(), d.x)
          .add(PI)
          .div(2 * PI),
        v = asin(d.y)
          .add(PI / 2)
          .div(PI);
      const fx = u.mul(gwF).sub(0.5),
        fy = v.mul(ghF).sub(0.5);
      const x0 = floor(fx),
        y0 = floor(fy),
        tx = fx.sub(x0),
        ty = fy.sub(y0);
      const at = (x: any, y: any) =>
        roOut.element(
          int(clamp(y, 0, ghF.sub(1)))
            .mul(U.gw)
            .add(int(x.add(gwF).mod(gwF))),
        );
      const base = mix(
        mix(at(x0, y0), at(x0.add(1), y0), tx),
        mix(at(x0, y0.add(1)), at(x0.add(1), y0.add(1)), tx),
        ty,
      );

      const twF = float(U.tw),
        thF = float(U.th);
      const qx = u.mul(float(U.tgw)).sub(0.5).sub(float(U.tj0)),
        qy = v.mul(float(U.tgh)).sub(0.5).sub(float(U.ti0));
      const cx = clamp(floor(qx), 0, twF.sub(2)),
        cy = clamp(floor(qy), 0, thF.sub(2));
      const fx2 = clamp(qx.sub(cx), 0, 1),
        fy2 = clamp(qy.sub(cy), 0, 1);
      const tat = (x: any, y: any) =>
        roTile.element(int(y).mul(U.tw).add(int(x)));
      const tileV = mix(
        mix(tat(cx, cy), tat(cx.add(1), cy), fx2),
        mix(tat(cx, cy.add(1)), tat(cx.add(1), cy.add(1)), fx2),
        fy2,
      );
      const edge = min(
        min(qx, twF.sub(1).sub(qx)),
        min(qy, thF.sub(1).sub(qy)),
      );
      const wT = clamp(edge.div(16), 0, 1).mul(U.tOn); // feather over 16 cells so the tile blends into the base
      const geoid = mix(base, tileV, wT);

      const dem = texture(this.demTex, vec2(u, v)).level(0).r;
      return mix(geoid.sub(U.ref), dem, U.layer);
    };

    // ---- ellipsoid + displacement (shared by surface, wireframe and borders)
    const dir = normalize(positionGeometry);
    const nu = float(1).div(sqrt(float(1).sub(U.e2.mul(dir.y).mul(dir.y))));
    const onEllipsoid = vec3(
      dir.x.mul(nu),
      dir.y.mul(nu).mul(float(1).sub(U.e2)),
      dir.z.mul(nu),
    );
    const displaced = onEllipsoid.add(
      dir.mul(heightAt(dir).mul(U.exag).div(U.a).mul(U.relief)),
    );

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.positionNode = displaced;
    // colour per fragment; the colour scale shows true heights (U.ref only affects displacement)
    const hF = heightAt(normalize(varying(dir))).add(
      U.ref.mul(float(1).sub(U.layer)),
    );
    const t = clamp(hF.sub(U.lo).div(U.hi.sub(U.lo)), 0, 1);
    this.rampTex = new THREE.DataTexture(
      buildLut(RAMPS[0]),
      256,
      1,
      THREE.RGBAFormat,
    );
    this.rampTex.colorSpace = THREE.SRGBColorSpace; // stored as sRGB, sampled as linear
    this.rampTex.magFilter = this.rampTex.minFilter = THREE.LinearFilter;
    this.rampTex.needsUpdate = true;
    const col = texture(
      this.rampTex,
      vec2(t.mul(255 / 256).add(0.5 / 256), 0.5),
    ).rgb; // texel-centre aligned
    const nrm = normalize(cross(dFdx(positionView), dFdy(positionView)));
    mat.colorNode = vec4(
      mix(vec3(0.36, 0.45, 0.56), col, U.field).mul(
        abs(nrm.z).mul(0.45).add(0.55),
      ),
      1,
    );
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 720, 360), mat));

    const wmat = new THREE.MeshBasicNodeMaterial({
      wireframe: true,
      transparent: true,
      opacity: 0.4,
      color: 0xffffff,
    });
    wmat.positionNode = onEllipsoid;
    this.wire = new THREE.Mesh(new THREE.SphereGeometry(1.0005, 48, 24), wmat);
    this.wire.visible = false;
    this.scene.add(this.wire);

    this.lineMat = new THREE.LineBasicNodeMaterial({
      color: 0x10151c,
      transparent: true,
      opacity: 0.9,
    });
    this.lineMat.positionNode = displaced.add(dir.mul(0.003));

    // graticule: follows the displaced surface, lifted slightly above it
    const gmat = new THREE.LineBasicNodeMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
    });
    gmat.positionNode = displaced.add(dir.mul(0.002));
    const gg = new THREE.BufferGeometry();
    gg.setAttribute(
      "position",
      new THREE.BufferAttribute(graticulePositions(15, 2), 3),
    );
    this.grat = new THREE.LineSegments(gg, gmat);
    this.grat.frustumCulled = false;
    this.grat.visible = false;
    this.scene.add(this.grat);

    // min / max markers (octahedra, so they differ from the round click marker)
    const octa = new THREE.OctahedronGeometry(1);
    this.extMin = new THREE.Mesh(
      octa,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
    );
    this.extMax = new THREE.Mesh(
      octa,
      new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
    );
    for (const m of [this.extMin, this.extMax]) {
      m.scale.setScalar(0.016);
      m.visible = false;
      this.scene.add(m);
    }

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    );
    this.marker.scale.setScalar(0.011);
    this.marker.visible = false;
    this.scene.add(this.marker);

    const el = renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener("pointermove", (e) => this.onHover?.(this.hit(e)));
    el.addEventListener("pointerleave", () => this.onHover?.(null));
    el.addEventListener(
      "pointerdown",
      (e) => (down = { x: e.clientX, y: e.clientY }),
    );
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4)
        return; // ignore orbit drags
      this.pickLL = this.hit(e);
      this.placeMarker();
      this.onPick?.(this.pickLL);
    });

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth,
        h2 = host.clientHeight;
      renderer.setSize(w, h2);
      this.camera.aspect = w / h2;
      this.camera.updateProjectionMatrix();
    });
    ro.observe(host);
    this.ro = ro;
    renderer.setAnimationLoop(() => {
      this.controls.update();
      renderer.render(this.scene, this.camera);
    });
  }

  /**
   * Compute pipeline for a set of latitude rows (a virtual grid of gw × gh cells):
   *  1. Legendre pass: per (row, order m)  E_m, O_m = Σn ΔC·P̄nm(sin φ) over even / odd (n−m).
   *     P̄nm(−φ) = (−1)^(n−m) P̄nm(φ), so the southern row needs no extra work: A(−φ) = E − O.
   *     Scaled forward-column recursion (mantissa + exponent, 2^64 steps) avoids float32 underflow at high m.
   *  2. Fill: Z_k = (A_k − iB_k)(−1)^k e^{iπk/gw}   (turns A cos mλ + B sin mλ into a plain inverse DFT)
   *  3. Stockham radix-2 FFT, log2(gw) ping-pong passes, whole batches of rows at once
   *  4. Store Re(result)·scale + n0 into the global grid or (column-cropped) into the tile buffer.
   */
  private buildCompute() {
    const { C, cBuf, sBuf, aE, aO, bE, bO, xr, xi, yr, yi, out, tileOut } =
      this;

    this.passLegendre = Fn(() => {
      const item = int(instanceIndex).add(C.off);
      If(item.lessThan(C.nrows.mul(C.stride)), () => {
        const r = item.div(C.stride),
          m = item.mod(C.stride);
        const lat = float(C.rowBase.add(r))
          .add(0.5)
          .div(float(C.gh))
          .mul(PI)
          .sub(PI / 2);
        const sl = sin(lat),
          cl = cos(lat),
          mf = float(m);
        const cE = float(0).toVar(),
          cO = float(0).toVar(),
          sE = float(0).toVar(),
          sO = float(0).toVar();
        const pmm = float(1).toVar(),
          ex = float(0).toVar(),
          wv = float(1).toVar();
        If(m.greaterThan(int(0)), () => {
          pmm.assign(cl.mul(Math.sqrt(3)));
          If(pmm.lessThan(1), () => {
            pmm.mulAssign(two64());
            ex.subAssign(1);
          });
          Loop(
            { start: int(2), end: m, type: "int", condition: "<=" },
            ({ i: k }: any) => {
              const kf = float(k);
              pmm.mulAssign(cl.mul(sqrt(kf.mul(2).add(1).div(kf.mul(2)))));
              If(pmm.lessThan(1), () => {
                pmm.mulAssign(two64());
                ex.subAssign(1);
              });
            },
          );
        });
        wv.assign(exp2(ex.mul(64))); // true value = mantissa · 2^(64·ex)
        const p1 = float(0).toVar(),
          p2 = float(0).toVar(),
          cur = float(0).toVar();
        Loop(
          { start: m, end: C.maxDeg, type: "int", condition: "<=" },
          ({ i: n }: any) => {
            const nf = float(n);
            If(n.equal(m), () => {
              cur.assign(pmm);
            })
              .ElseIf(n.equal(m.add(int(1))), () => {
                cur.assign(sl.mul(sqrt(mf.mul(2).add(3))).mul(pmm));
              })
              .Else(() => {
                const nm = nf.sub(mf),
                  np = nf.add(mf);
                const a = sqrt(
                  nf.mul(2).sub(1).mul(nf.mul(2).add(1)).div(nm.mul(np)),
                );
                const b = sqrt(
                  nf
                    .mul(2)
                    .add(1)
                    .mul(np.sub(1))
                    .mul(nm.sub(1))
                    .div(nm.mul(np).mul(nf.mul(2).sub(3))),
                );
                cur.assign(a.mul(sl).mul(p1).sub(b.mul(p2)));
              });
            If(abs(cur).greaterThan(two64()), () => {
              cur.mulAssign(inv64());
              p1.mulAssign(inv64());
              ex.addAssign(1);
              wv.assign(exp2(ex.mul(64)));
            });
            const k = n
              .mul(n.add(int(1)))
              .div(int(2))
              .add(m);
            const par = float(n.sub(m).mod(int(2)));
            const tc = cBuf.element(k).mul(cur).mul(wv),
              ts = sBuf.element(k).mul(cur).mul(wv);
            cE.addAssign(tc.mul(float(1).sub(par)));
            cO.addAssign(tc.mul(par));
            sE.addAssign(ts.mul(float(1).sub(par)));
            sO.addAssign(ts.mul(par));
            p2.assign(p1);
            p1.assign(cur);
          },
        );
        aE.element(item).assign(cE);
        aO.element(item).assign(cO);
        bE.element(item).assign(sE);
        bO.element(item).assign(sO);
      });
    })().compute(CHUNK);

    this.passFill = Fn(() => {
      const i = int(instanceIndex);
      If(i.lessThan(C.rows.mul(C.gw)), () => {
        const k = i.mod(C.gw),
          iy = C.fr0.add(i.div(C.gw));
        const d = iy.sub(C.rowBase);
        const direct = d.greaterThanEqual(int(0)).and(d.lessThan(C.nrows));
        const src = select(direct, d, C.gh.sub(1).sub(iy).sub(C.rowBase)); // mirrored row for the other hemisphere
        const sg = select(direct, float(1), float(-1));
        const zr = float(0).toVar(),
          zi = float(0).toVar();
        If(k.lessThanEqual(C.maxDeg), () => {
          const o = src.mul(C.stride).add(k);
          const A = aE.element(o).add(sg.mul(aO.element(o))),
            B = bE.element(o).add(sg.mul(bO.element(o)));
          const ph = float(k).mul(PI).div(float(C.gw));
          const sgn = float(1).sub(float(k.mod(int(2))).mul(2));
          zr.assign(sgn.mul(A.mul(cos(ph)).add(B.mul(sin(ph)))));
          zi.assign(sgn.mul(A.mul(sin(ph)).sub(B.mul(cos(ph)))));
        });
        xr.element(i).assign(zr);
        xi.element(i).assign(zi);
      });
    })().compute(BATCH);

    // one Stockham stage (length n, stride s): reads (sr,si), writes (tr,ti); exponent sign + = inverse DFT
    const stage = (sr: any, si: any, tr: any, ti: any) =>
      Fn(() => {
        const idx = int(instanceIndex),
          half = C.gw.div(2);
        If(idx.lessThan(C.rows.mul(half)), () => {
          const r = idx.div(half),
            b = idx.mod(half);
          const s = C.fs,
            p = b.div(s),
            q = b.mod(s),
            mh = C.fn.div(2),
            base = r.mul(C.gw);
          const i0 = base.add(q).add(s.mul(p)),
            i1 = base.add(q).add(s.mul(p.add(mh)));
          const ar = sr.element(i0),
            ai = si.element(i0),
            br = sr.element(i1),
            bi = si.element(i1);
          const o0 = base.add(q).add(s.mul(p.mul(2))),
            o1 = o0.add(s);
          const th = float(p)
            .mul(2 * PI)
            .div(float(C.fn));
          const wr = cos(th),
            wi = sin(th),
            dr = ar.sub(br),
            di = ai.sub(bi);
          tr.element(o0).assign(ar.add(br));
          ti.element(o0).assign(ai.add(bi));
          tr.element(o1).assign(dr.mul(wr).sub(di.mul(wi)));
          ti.element(o1).assign(dr.mul(wi).add(di.mul(wr)));
        });
      })().compute(BATCH / 2);
    this.stageXY = stage(xr, xi, yr, yi);
    this.stageYX = stage(yr, yi, xr, xi);

    this.storeGlobal = Fn(() => {
      const i = int(instanceIndex);
      If(i.lessThan(C.rows.mul(C.gw)), () => {
        const v = mix(xr.element(i), yr.element(i), C.fin); // result sits in x or y depending on the stage count
        out.element(C.fr0.mul(C.gw).add(i)).assign(v.mul(C.scale).add(C.n0));
      });
    })().compute(BATCH);

    this.storeTile = Fn(() => {
      const i = int(instanceIndex);
      If(i.lessThan(C.rows.mul(C.gw)), () => {
        const j = i.mod(C.gw).sub(C.tj0),
          row = C.fr0.add(i.div(C.gw)).sub(C.ti0);
        If(j.greaterThanEqual(int(0)).and(j.lessThan(C.tw)), () => {
          const v = mix(xr.element(i), yr.element(i), C.fin);
          tileOut
            .element(row.mul(C.tw).add(j))
            .assign(v.mul(C.scale).add(C.n0));
        });
      });
    })().compute(BATCH);
  }

  private async pipeline(
    j: {
      deg: number;
      gw: number;
      gh: number;
      rowBase: number;
      nrows: number;
      first: number;
      count: number;
      store: any;
    },
    stale: () => boolean,
    progress: (f: number) => void,
  ) {
    const C = this.C,
      queue = (this.renderer as any).backend?.device?.queue;
    C.maxDeg.value = j.deg;
    C.stride.value = j.deg + 1;
    C.gw.value = j.gw;
    C.gh.value = j.gh;
    C.rowBase.value = j.rowBase;
    C.nrows.value = j.nrows;
    const abort = () => {
      if (stale()) throw new Error("superseded");
    };

    const total1 = j.nrows * (j.deg + 1);
    for (let off = 0; off < total1; off += CHUNK) {
      abort();
      C.off.value = off;
      await this.renderer.computeAsync(this.passLegendre);
      await queue?.onSubmittedWorkDone?.(); // pace submissions so no single one trips the GPU watchdog
      progress(0.85 * Math.min(1, (off + CHUNK) / total1));
    }

    const stages = Math.log2(j.gw),
      rowsPer = Math.max(1, Math.floor(BATCH / j.gw));
    C.fin.value = stages % 2;
    for (let r0 = j.first; r0 < j.first + j.count; r0 += rowsPer) {
      abort();
      C.fr0.value = r0;
      C.rows.value = Math.min(rowsPer, j.first + j.count - r0);
      await this.renderer.computeAsync(this.passFill);
      for (let t = 0, n = j.gw, s = 1; n >= 2; t++, n >>= 1, s <<= 1) {
        C.fn.value = n;
        C.fs.value = s;
        await this.renderer.computeAsync(
          t % 2 === 0 ? this.stageXY : this.stageYX,
        );
      }
      await this.renderer.computeAsync(j.store);
      await queue?.onSubmittedWorkDone?.();
      progress(0.85 + 0.15 * Math.min(1, (r0 + rowsPer - j.first) / j.count));
    }
  }

  /**
   * Compute the global geoid grid. With `tiling`, degrees above BASE_DEG give a cheap global layer
   * (degree BASE_DEG) and the full degree is then computed for the visible window only (see requestTile).
   * A newer call aborts an older one at its next dispatch (rejects with "superseded").
   */
  solve(p: Prepared, opts: SolveOptions = {}): Promise<GeoidGrid> {
    const gen = ++this.gen;
    const job = this.chain.then(() => this.doSolve(p, gen, opts));
    this.chain = job.catch(() => {});
    return job;
  }

  private async doSolve(
    p: Prepared,
    gen: number,
    opts: SolveOptions,
  ): Promise<GeoidGrid> {
    const stale = () => gen !== this.gen;
    if (stale()) throw new Error("superseded");
    this.prep = p;
    this.tilingOn = !!opts.tiling;
    this.dropTile();
    this.cBuf.value.array.set(p.c);
    this.cBuf.value.needsUpdate = true;
    this.sBuf.value.array.set(p.s);
    this.sBuf.value.needsUpdate = true;
    this.C.scale.value = p.scale;
    this.C.n0.value = p.n0;

    const deg = this.tilingOn && p.deg > BASE_DEG ? BASE_DEG : p.deg;
    const gw = gridSize(deg),
      gh = gw / 2;
    await this.pipeline(
      {
        deg,
        gw,
        gh,
        rowBase: gh / 2,
        nrows: gh / 2,
        first: 0,
        count: gh,
        store: this.storeGlobal,
      },
      stale,
      (f) => opts.onProgress?.(f),
    );
    const buf = await this.renderer.getArrayBufferAsync(this.out.value);
    this.geo = {
      data: new Float32Array(buf, 0, gw * gh).slice(),
      w: gw,
      h: gh,
    };
    this.ext = this.findExtremes(this.geo);
    this.onExtremes?.(this.ext);
    this.U.gw.value = gw;
    this.U.gh.value = gh; // publish: render now reads the new grid layout
    this.placeMarker();
    this.scheduleTile(0);
    return this.geo;
  }

  // ---------------------------------------------------------------- detail tiles
  private scheduleTile(delay: number) {
    clearTimeout(this.tileTimer);
    this.tileTimer = setTimeout(() => this.requestTile(), delay);
  }
  private dropTile() {
    this.U.tOn.value = 0;
    this.tile = null;
    this.tileGen++;
  }

  /** Window of the virtual full-resolution grid around the view centre, or null when zoomed out too far. */
  private viewWindow(deg: number) {
    const gwT = gridSize(deg),
      ghT = gwT / 2,
      cell = 360 / gwT;
    const d = this.camera.position.length();
    const halfRad =
      (d - 1) *
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) *
      Math.max(1, this.camera.aspect) *
      1.25;
    const halfDeg = THREE.MathUtils.radToDeg(halfRad);
    if (halfDeg > 28) return null;
    const c = this.hitNdc(0, 0);
    if (!c) return null;
    const pad = 24,
      cosl = Math.max(0.2, Math.cos((c.lat * PI) / 180));
    const th = Math.min(TILE_MAX, Math.ceil((2 * halfDeg) / cell) + pad);
    const tw = Math.min(TILE_MAX, Math.ceil((2 * halfDeg) / cosl / cell) + pad);
    const clampI = (v: number, hi: number) =>
      Math.max(0, Math.min(hi, Math.round(v)));
    return {
      gwT,
      tw,
      th,
      i0: clampI(((c.lat + 90) / 180) * ghT - th / 2, ghT - th),
      j0: clampI(((c.lon + 180) / 360) * gwT - tw / 2, gwT - tw),
    };
  }

  private requestTile() {
    const p = this.prep;
    if (!p || !this.tilingOn || p.deg <= BASE_DEG) {
      this.onTile?.("");
      return;
    }
    const w = this.viewWindow(p.deg);
    if (!w) {
      this.dropTile();
      this.onTile?.("Detail tile: zoom in to refine");
      return;
    }
    const t = this.tile;
    if (
      t &&
      t.gwT === w.gwT &&
      w.i0 >= t.i0 &&
      w.i0 + w.th <= t.i0 + t.h &&
      w.j0 >= t.j0 &&
      w.j0 + w.tw <= t.j0 + t.w &&
      t.w <= 2 * w.tw + 64 &&
      t.h <= 2 * w.th + 64
    ) {
      this.U.tOn.value = 1;
      return;
    } // current tile still fits
    const gen = this.gen,
      tg = ++this.tileGen;
    const job = this.chain.then(() =>
      this.doTile(p, w, () => gen !== this.gen || tg !== this.tileGen),
    );
    this.chain = job.catch(() => {});
  }

  private async doTile(
    p: Prepared,
    w: { gwT: number; tw: number; th: number; i0: number; j0: number },
    stale: () => boolean,
  ) {
    if (stale()) return;
    const { C, U } = this;
    U.tOn.value = 0;
    this.tile = null; // the tile buffer is about to be overwritten
    C.scale.value = p.scale;
    C.n0.value = p.n0;
    C.tj0.value = w.j0;
    C.ti0.value = w.i0;
    C.tw.value = w.tw;
    try {
      await this.pipeline(
        {
          deg: p.deg,
          gw: w.gwT,
          gh: w.gwT / 2,
          rowBase: w.i0,
          nrows: w.th,
          first: w.i0,
          count: w.th,
          store: this.storeTile,
        },
        stale,
        (f) => this.onTile?.(`Detail tile: ${Math.round(f * 100)}%`),
      );
      const buf = await this.renderer.getArrayBufferAsync(this.tileOut.value);
      if (stale()) return;
      this.tile = {
        data: new Float32Array(buf, 0, w.tw * w.th).slice(),
        w: w.tw,
        h: w.th,
        i0: w.i0,
        j0: w.j0,
        gwT: w.gwT,
      };
      U.tgw.value = w.gwT;
      U.tgh.value = w.gwT / 2;
      U.ti0.value = w.i0;
      U.tj0.value = w.j0;
      U.tw.value = w.tw;
      U.th.value = w.th;
      U.tOn.value = 1;
      this.placeMarker();
      this.onTile?.(
        `Detail tile ready: degree ${p.deg}, ${w.tw}×${w.th} cells`,
      );
    } catch (e) {
      if (!String(e).includes("superseded"))
        this.onTile?.(`Detail tile failed: ${e}`);
    }
  }

  // ---------------------------------------------------------------- picking helpers
  private bilinear(
    g: Float32Array,
    W: number,
    H: number,
    lat: number,
    lon: number,
  ) {
    const fx = ((lon + 180) / 360) * W - 0.5,
      fy = ((lat + 90) / 180) * H - 0.5;
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy),
      tx = fx - x0,
      ty = fy - y0;
    const at = (x: number, y: number) =>
      g[Math.min(H - 1, Math.max(0, y)) * W + (((x % W) + W) % W)];
    return (
      (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
      (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
    );
  }
  /** Geoid undulation N (base grid blended with the detail tile, like the shader) and DEM elevation (MSL); NaN if unavailable. */
  sample(lat: number, lon: number) {
    let geoid = this.geo
      ? this.bilinear(this.geo.data, this.geo.w, this.geo.h, lat, lon)
      : NaN;
    const t = this.tile;
    if (t && this.U.tOn.value > 0.5) {
      const qx = ((lon + 180) / 360) * t.gwT - 0.5 - t.j0,
        qy = ((lat + 90) / 180) * (t.gwT / 2) - 0.5 - t.i0;
      const wT = Math.max(
        0,
        Math.min(1, Math.min(qx, t.w - 1 - qx, qy, t.h - 1 - qy) / 16),
      );
      if (wT > 0) {
        const cx = Math.max(0, Math.min(t.w - 2, Math.floor(qx))),
          cy = Math.max(0, Math.min(t.h - 2, Math.floor(qy)));
        const fx = Math.max(0, Math.min(1, qx - cx)),
          fy = Math.max(0, Math.min(1, qy - cy));
        const at = (x: number, y: number) => t.data[y * t.w + x];
        const tv =
          (at(cx, cy) * (1 - fx) + at(cx + 1, cy) * fx) * (1 - fy) +
          (at(cx, cy + 1) * (1 - fx) + at(cx + 1, cy + 1) * fx) * fy;
        geoid = geoid * (1 - wT) + tv * wT;
      }
    }
    return {
      geoid,
      dem: this.demGrid
        ? this.bilinear(this.demGrid, DEM_W, DEM_H, lat, lon)
        : NaN,
    };
  }
  /** Normalised radial displacement used by the shader at this point. */
  private disp(lat: number, lon: number) {
    const s = this.sample(lat, lon),
      U = this.U;
    const h = (U.layer.value as number) > 0.5 ? s.dem : s.geoid - this.ref;
    return Number.isFinite(h)
      ? (h * (U.exag.value as number) * (U.relief.value as number)) /
          (U.a.value as number)
      : 0;
  }
  private surface(lat: number, lon: number, hn: number) {
    const p = (lat * PI) / 180,
      l = (lon * PI) / 180,
      e2 = this.U.e2.value as number;
    const d = new THREE.Vector3(
      Math.cos(p) * Math.cos(l),
      Math.sin(p),
      -Math.cos(p) * Math.sin(l),
    );
    const nu = 1 / Math.sqrt(1 - e2 * d.y * d.y);
    return new THREE.Vector3(
      d.x * nu,
      d.y * nu * (1 - e2),
      d.z * nu,
    ).addScaledVector(d, hn);
  }
  /** Global minimum and maximum of the geoid grid (cell centres; with tiling on this is the base layer). */
  private findExtremes(g: GeoidGrid): Extremes {
    let lo = Infinity,
      hi = -Infinity,
      il = 0,
      ih = 0;
    for (let i = 0; i < g.data.length; i++) {
      const v = g.data[i];
      if (v < lo) {
        lo = v;
        il = i;
      }
      if (v > hi) {
        hi = v;
        ih = i;
      }
    }
    const at = (i: number, value: number): Extreme => ({
      lat: -90 + ((Math.floor(i / g.w) + 0.5) / g.h) * 180,
      lon: -180 + (((i % g.w) + 0.5) / g.w) * 360,
      value,
    });
    return { min: at(il, lo), max: at(ih, hi) };
  }
  private placeMarker() {
    const p = this.pickLL;
    this.marker.visible = !!p;
    if (p)
      this.marker.position.copy(
        this.surface(p.lat, p.lon, this.disp(p.lat, p.lon) + 0.004),
      );
    const e = this.ext,
      on = this.extremesOn && !!e;
    this.extMin.visible = this.extMax.visible = on;
    if (e && on) {
      this.extMin.position.copy(
        this.surface(
          e.min.lat,
          e.min.lon,
          this.disp(e.min.lat, e.min.lon) + 0.008,
        ),
      );
      this.extMax.position.copy(
        this.surface(
          e.max.lat,
          e.max.lon,
          this.disp(e.max.lat, e.max.lon) + 0.008,
        ),
      );
    }
  }
  private hit(ev: PointerEvent): LatLon | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.hitNdc(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    );
  }
  /** Ray -> displaced surface: intersect with an ellipsoid inflated by the local displacement, iterated. */
  private hitNdc(nx0: number, ny0: number): LatLon | null {
    this.ray.setFromCamera(new THREE.Vector2(nx0, ny0), this.camera);
    const o = this.ray.ray.origin,
      d = this.ray.ray.direction;
    const b = Math.sqrt(1 - (this.U.e2.value as number));
    let hn = 0,
      ll: LatLon | null = null;
    for (let it = 0; it < 4; it++) {
      const sx = 1 / (1 + hn),
        sy = 1 / (b + hn);
      const ox = o.x * sx,
        oy = o.y * sy,
        oz = o.z * sx,
        dx = d.x * sx,
        dy = d.y * sy,
        dz = d.z * sx;
      const A = dx * dx + dy * dy + dz * dz,
        B = 2 * (ox * dx + oy * dy + oz * dz),
        C = ox * ox + oy * oy + oz * oz - 1;
      const disc = B * B - 4 * A * C;
      if (disc < 0) return null;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t < 0) return null;
      const x = o.x + d.x * t,
        y = o.y + d.y * t,
        z = o.z + d.z * t;
      const nx = x * sx * sx,
        ny = y * sy * sy,
        nz = z * sx * sx,
        len = Math.hypot(nx, ny, nz);
      ll = {
        lat: (Math.asin(ny / len) * 180) / PI,
        lon: (Math.atan2(-nz, nx) * 180) / PI,
      };
      hn = this.disp(ll.lat, ll.lon);
    }
    return ll;
  }

  // ---------------------------------------------------------------- borders / style
  setBorders(rings: Ring[]) {
    const pos: number[] = [];
    const dirOf = (lon: number, lat: number) => {
      const l = (lon * PI) / 180,
        p = (lat * PI) / 180;
      pos.push(
        Math.cos(p) * Math.cos(l),
        Math.sin(p),
        -Math.cos(p) * Math.sin(l),
      );
    };
    for (const r of rings)
      for (let i = 0; i < r.length - 1; i++) {
        const [l0, a0] = r[i],
          [l1, a1] = r[i + 1];
        if (Math.abs(l1 - l0) > 180) continue;
        const n = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(l1 - l0), Math.abs(a1 - a0)) / 2),
        );
        for (let k = 0; k < n; k++) {
          dirOf(l0 + ((l1 - l0) * k) / n, a0 + ((a1 - a0) * k) / n);
          dirOf(l0 + ((l1 - l0) * (k + 1)) / n, a0 + ((a1 - a0) * (k + 1)) / n);
        }
      }
    if (this.borderLines) {
      this.scene.remove(this.borderLines);
      this.borderLines.geometry.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.borderLines = new THREE.LineSegments(g, this.lineMat);
    this.borderLines.frustumCulled = false;
    this.borderLines.visible = this.bordersOn;
    this.scene.add(this.borderLines);
  }

  setRamp(lut: Uint8Array) {
    (this.rampTex.image.data as Uint8Array).set(lut);
    this.rampTex.needsUpdate = true;
  }
  setShape(a: number, invF: number) {
    const f = 1 / invF;
    this.U.a.value = a;
    this.U.e2.value = f * (2 - f);
    this.placeMarker();
  }
  setRef(v: number) {
    this.ref = v;
    this.U.ref.value = v;
    this.placeMarker();
  }
  setDem(data: Float32Array) {
    (this.demTex.image.data as Float32Array).set(data);
    this.demTex.needsUpdate = true;
    this.demGrid = data;
    this.placeMarker();
  }
  setStyle(o: {
    show: Show;
    layer: "geoid" | "dem";
    exag: number;
    lo: number;
    hi: number;
    borders: boolean;
    graticule: boolean;
    extremes: boolean;
  }) {
    const U = this.U;
    this.bordersOn = o.borders;
    this.grat.visible = o.graticule;
    this.extremesOn = o.extremes;
    if (this.borderLines) this.borderLines.visible = o.borders;
    U.exag.value = o.exag;
    U.lo.value = o.lo;
    U.hi.value = o.hi > o.lo ? o.hi : o.lo + 1;
    U.layer.value = o.layer === "dem" ? 1 : 0;
    U.relief.value = o.show === "ellipsoid" ? 0 : 1;
    U.field.value = o.show === "ellipsoid" ? 0 : 1;
    this.wire.visible = o.show !== "geoid";
    this.placeMarker();
  }
  dispose() {
    clearTimeout(this.tileTimer);
    this.ro.disconnect();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
