<script lang="ts">
  import { onMount } from "svelte";
  import RampSelect from "./lib/components/RampSelect.svelte";
  import { Viewer, type GeoidGrid, type Extremes } from "./lib/viewer";
  import {
    ELLIPSOIDS,
    parseGfcStream,
    prepare,
    type GravityModel,
    MAXDEG,
    parseBin,
  } from "./lib/geodesy";
  import { loadDem, PRESET_DEMS, type DemSource } from "./lib/dem";
  import { RAMPS, buildLut, makeRamp, rampCss } from "./lib/ramp";
  import {
    extractRings,
    drawBorders,
    drawMarker,
    type Ring,
  } from "./lib/borders";
  import egm84Url from "./data/EGM84.f32?url";
  import egm96Url from "./data/EGM96.f32?url";
  import egm2008Url from "./data/EGM2008.f32?url";
  import bordersUrl from "./data/ne_110m_admin_0_countries.json?url";
  import { parseCof, parseEgm } from "./lib/cof";
  import Slider from "./lib/components/Slider.svelte";
  import { SHOW_OPTIONS, type Show } from "./lib/types";
  import Select from "./lib/components/Select.svelte";
  import CheckBox from "./lib/components/CheckBox.svelte";

  const DEM_FETCH_OPTIONS = [
    { value: "wms", label: "WMS (GetMap, EPSG:4326)" },
    { value: "tiles", label: "XYZ / WMTS REST (Web Mercator)" },
  ];
  const DEM_BAND_OPTIONS = [
    { value: "gray", label: "Grayscale (red channel)" },
    { value: "terrarium", label: "Terrarium RGB" },
    { value: "mapbox", label: "Mapbox Terrain RGB" },
  ];
  const PROJECTION_OPTION = [
    { value: "mollweide", label: "Mollweide" },
    { value: "equirect", label: "Equirectangular" },
  ];

  const supported = typeof navigator !== "undefined" && "gpu" in navigator;
  let host: HTMLDivElement;
  let viewer = $state.raw<Viewer>();
  let status = $state("");
  let tiling = $state(true);
  let tileMessage = $state("");

  // gravity model
  let models = $state.raw<GravityModel[]>([]);
  let modelId = $state("");
  let maxDeg = $state(180);
  let gfcUrl = $state("");
  const model = $derived(models.find((m) => m.id === modelId) ?? null);
  const degree = $derived(model ? Math.min(maxDeg, model.maxDeg) : maxDeg);
  let dragDeg = $state<number | null>(null); // value while dragging
  const shownDeg = $derived(dragDeg ?? degree);

  // ellipsoid
  let datum = $state("0");
  let customA = $state(6378137);
  let customInvF = $state(298.257);
  const ell = $derived(
    datum === "custom"
      ? customA > 1e6 && customInvF > 1
        ? { name: "Custom", a: customA, invF: customInvF }
        : null
      : ELLIPSOIDS[+datum],
  );

  // borders
  let showBorders = $state(true);
  let borders = $state.raw<Ring[]>([]);

  // display
  let show = $state<Show>("geoid");
  let layer = $state<"geoid" | "dem">("geoid");
  let exagLog = $state({ geoid: 4, dem: 1.3 });
  let projection = $state<"equirect" | "mollweide">("mollweide");
  let removeMean = $state(true);
  let meanN = $state(0);
  let showGraticule = $state(false);
  let showExtremes = $state(false);
  let extremes = $state.raw<Extremes | null>(null);

  let grid = $state.raw<GeoidGrid | null>(null);
  let gRange = $state({ min: -100, max: 100 });
  let demRange = $state({ min: 0, max: 1 });
  let demLoaded = $state(false);
  const range = $derived(layer === "dem" ? demRange : gRange);

  // DEM sources
  let dems = $state<DemSource[]>([...PRESET_DEMS]);
  let form = $state<DemSource>({
    name: "",
    kind: "wms",
    url: "",
    layers: "",
    encoding: "gray",
    grayMin: 0,
    grayMax: 8000,
    zoom: 3,
  });

  // viewer interactions
  let hover = $state<{ lat: number; lon: number } | null>(null);
  let pick = $state<{ lat: number; lon: number } | null>(null);
  let demStamp = $state(0); // bumped when a DEM loads, so readouts refresh

  // color ramp
  let rampId = $state("geoid");
  let reverseRamp = $state(false);
  const rampDef = $derived(RAMPS.find((r) => r.id === rampId) ?? RAMPS[0]);

  const info = $derived.by(() => {
    grid;
    demStamp; // dependencies: recompute when the geoid or DEM changes
    if (!viewer || !pick) return null;
    const s = viewer.sample(pick.lat, pick.lon);
    return { ...pick, N: s.geoid, msl: s.dem, hae: s.dem + s.geoid };
  });

  const formatLatLon = (p: { lat: number; lon: number }) =>
    `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? "N" : "S"}, ${Math.abs(p.lon).toFixed(4)}° ${p.lon >= 0 ? "E" : "W"}`;
  const formatMeter = (v: number) =>
    Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(2)} m` : "–";

  onMount(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let destroyed = false;

    fetch(bordersUrl)
      .then((r) => r.json())
      .then((j) => (borders = extractRings(j)))
      .catch((e) => (status = `Could not load borders: ${e}`));

    if (supported)
      Viewer.create(host)
        .then((v) => {
          v.onTile = (m) => (tileMessage = m);
          v.onHover = (p) => (hover = p);
          v.onPick = (p) => (pick = p);
          v.onExtremes = (e) => (extremes = e);
          viewer = v;
        })
        .catch((e) => (status = String(e)));

    const ORDER = ["egm84", "egm96", "egm2008"];
    const sortModels = (list: typeof models) =>
      [...list].sort((a, b) => {
        const ia = ORDER.indexOf(a.id);
        const ib = ORDER.indexOf(b.id);
        return (
          (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) -
          (ib === -1 ? Number.MAX_SAFE_INTEGER : ib)
        );
      });

    const loadBundled = async (
      id: string,
      label: string,
      url: string,
      deg = MAXDEG,
    ) => {
      const bytes = 24 + 8 * (((deg + 1) * (deg + 2)) / 2);
      const r = await fetch(url, {
        headers: { Range: `bytes=0-${bytes - 1}` },
      });
      if (!r.ok) throw new Error(`${label}: ${r.statusText}`);
      //const m = await parseGfcStream(r.body, MAXDEG);
      const m = parseBin(await r.arrayBuffer(), label, deg);
      return { ...m, id, name: `${label} (n ≤ ${m.maxDeg})` };
    };

    (async () => {
      const errors: string[] = [];

      // Load default EGM96 first so default selection & degree initialize promptly
      try {
        status = "Loading EGM96…";
        const egm96 = await loadBundled("egm96", "EGM96", egm96Url);
        if (destroyed) return;
        models = sortModels([egm96, ...models.filter((m) => m.id !== "egm96")]);
        modelId = egm96.id;
        maxDeg = Math.min(egm96.maxDeg ?? 180, 180);
      } catch (e) {
        if (destroyed || (e as { name?: string })?.name === "AbortError")
          return;
        errors.push(`EGM96: ${e}`);
      }

      if (destroyed) return;
      status = "Loading EGM84 & EGM2008…";

      const secondary = await Promise.allSettled([
        loadBundled("egm84", "EGM84", egm84Url),
        loadBundled("egm2008", "EGM2008", egm2008Url),
      ]);

      if (destroyed || signal.aborted) return;

      const loadedSecondary: typeof models = [];
      const labels = ["EGM84", "EGM2008"];

      secondary.forEach((res, idx) => {
        if (res.status === "fulfilled") {
          loadedSecondary.push(res.value);
        } else if ((res.reason as { name?: string })?.name !== "AbortError") {
          errors.push(`${labels[idx]}: ${res.reason}`);
        }
      });

      if (loadedSecondary.length > 0) {
        const loadedIds = new Set(loadedSecondary.map((m) => m.id));
        models = sortModels([
          ...models.filter((m) => !loadedIds.has(m.id)),
          ...loadedSecondary,
        ]);
      }

      status = errors.length > 0 ? `Could not load ${errors.join("; ")}` : "";
    })();

    return () => viewer?.dispose();
  });

  let token = 0;
  $effect(() => {
    const v = viewer,
      m = model,
      e = ell,
      d = degree;
    const tl = tiling;
    if (!v || !m || !e) return;
    const t = ++token,
      t0 = performance.now();
    status = "Computing…";
    const p = prepare(m, e, d);
    v.solve(p, {
      tiling: tl,
      onProgress: (f) => (status = `Computing… ${Math.round(f * 100)}%`),
    })
      .then((g) => {
        if (t !== token) return;
        let lo = Infinity,
          hi = -Infinity;
        for (const x of g.data) {
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        grid = g;
        gRange = { min: lo, max: hi };
        status = `Degree ${p.deg} on ${g.w}×${g.h} grid in ${(performance.now() - t0).toFixed(0)} ms`;
      })
      .catch((err) => {
        if (String(err).includes("superseded")) return; // replaced by a newer request
        status = `Compute failed: ${err}`;
      });
  });
  $effect(() => {
    if (ell) viewer?.setShape(ell.a, ell.invF);
  });
  $effect(() => {
    if (viewer && borders.length) viewer.setBorders(borders);
  });
  $effect(() =>
    viewer?.setStyle({
      show,
      layer,
      exag: 10 ** exagLog[layer],
      lo: range.min,
      hi: range.max,
      borders: showBorders,
      graticule: showGraticule,
      extremes: showExtremes,
    }),
  );
  $effect(() => viewer?.setRef(removeMean ? meanN : 0));
  $effect(() => viewer?.setRamp(buildLut(rampDef, reverseRamp)));
  $effect(() => {
    model?.id;
    dragDeg = null;
  });
  $effect(() => {
    if (model && maxDeg > model.maxDeg) maxDeg = model.maxDeg;
  });

  // 2D map plot (inverse projection per pixel)
  let mapCanvas: HTMLCanvasElement;
  $effect(() => {
    const g = grid,
      proj = projection,
      { min: lo, max: hi } = gRange;
    const bd = showBorders ? borders : [];
    const rampFunction = makeRamp(rampDef, reverseRamp);
    const pk = pick;
    if (!g || !mapCanvas) return;
    const W = 720,
      H = 360,
      ctx = mapCanvas.getContext("2d")!,
      img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let lat: number, lon: number;
        if (proj === "equirect") {
          lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
          lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
        } else {
          const nx = ((x + 0.5) / W) * 2 - 1,
            ny = 1 - ((y + 0.5) / H) * 2,
            th = Math.asin(ny);
          if (Math.abs(nx) > Math.cos(th)) continue;
          lat = Math.asin((2 * th + Math.sin(2 * th)) / Math.PI);
          lon = (Math.PI * nx) / Math.cos(th);
        }
        const gx = Math.min(
          g.w - 1,
          Math.floor(((lon + Math.PI) / (2 * Math.PI)) * g.w),
        );
        const gy = Math.min(
          g.h - 1,
          Math.floor(((lat + Math.PI / 2) / Math.PI) * g.h),
        );
        const [r, gg, b] = rampFunction(
          (g.data[gy * g.w + gx] - lo) / (hi - lo || 1),
        );
        img.data.set([r, gg, b, 255], (y * W + x) * 4);
      }
    ctx.putImageData(img, 0, 0);
    drawBorders(ctx, bd, proj, W, H);
    if (pk) drawMarker(ctx, pk.lat, pk.lon, proj, W, H);
  });

  async function addModel(fn: () => Promise<GravityModel>) {
    try {
      status = "Loading model…";
      const m = await fn();
      models = [...models, m];
      modelId = m.id;
      maxDeg = Math.min(maxDeg, m.maxDeg);
    } catch (e) {
      status = `Model load failed: ${e}`;
    }
  }
  const onFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    const cof = files.find((f) => /\.cof$/i.test(f.name));
    const egm = files.find((f) => /\.egm$/i.test(f.name));
    const gfc = files.find((f) => /\.(gfc|txt)$/i.test(f.name));

    if (cof) {
      addModel(async () => {
        const meta = egm ? parseEgm(await egm.text()) : {};
        if (!egm)
          status =
            "No .egm file selected: assuming GM and radius of EGM96/EGM2008";
        return parseCof(
          await cof.arrayBuffer(),
          meta,
          MAXDEG,
          cof.name.replace(/(_egm)?\.cof$/i, ""),
        );
      });
    } else if (gfc) {
      addModel(() =>
        parseGfcStream(gfc.stream(), MAXDEG, (b) => {
          status = `Reading ${(b / 1e6).toFixed(0)} of ${(gfc.size / 1e6).toFixed(0)} MB…`;
        }),
      );
    } else if (egm) {
      status = "Select the .egm file together with its .cof file";
    }
    input.value = ""; // allow re-selecting the same files
  };

  const viaProxy = (url: string) => {
    try {
      const x = new URL(url);
      return x.hostname === "icgem.gfz.de"
        ? `/icgem${x.pathname}${x.search}`
        : u;
    } catch {
      return url;
    }
  };

  const fetchGfc = () =>
    addModel(async () => {
      const r = await fetch(viaProxy(gfcUrl));
      if (!r.ok || !r.body) throw new Error(r.statusText);
      return parseGfcStream(r.body, MAXDEG);
    });

  async function useDem(s: DemSource) {
    try {
      status = `Fetching ${s.name}…`;
      const r = await loadDem(s);
      viewer?.setDem(r.data);
      demStamp++;
      demRange = { min: r.min, max: r.max };
      demLoaded = true;
      layer = "dem";
      status = `DEM loaded: ${r.min.toFixed(0)} … ${r.max.toFixed(0)} m`;
    } catch (e) {
      status = String(e);
    }
  }
  function addDem() {
    if (!form.url) return;
    const s = {
      ...form,
      name: form.name || new URL(form.url.replace(/\{.*?\}/g, "0")).hostname,
    };
    dems = [...dems, s];
    useDem(s);
  }
</script>

<main>
  <aside>
    <h1>Geodesy viewer</h1>
    {#if !supported}<p class="warn">
        This browser has no WebGPU. Use a recent Chrome, Edge or Safari.
      </p>{/if}

    <section>
      <h2>Gravity model</h2>
      <select bind:value={modelId} disabled={!models.length}>
        {#each models as m}<option value={m.id}>{m.name}</option>{/each}
      </select>
      {#if model}
        {#key model.id}
          <Slider
            label={`Maximum degree: ${shownDeg}`}
            min="2"
            max={model.maxDeg}
            value={degree}
            labelPosition="top"
            showOutput={false}
            oninput={(e) => (dragDeg = +e.currentTarget.value)}
            onchange={(e) => {
              maxDeg = +e.currentTarget.value;
              dragDeg = null;
            }}
          />
        {/key}
      {/if}
      <CheckBox bind:checked={tiling}>Detail tiles above degree 512</CheckBox>
      <label>
        Load .gfc or .egm + .cof <input
          type="file"
          accept=".gfc,.txt,.cof,.egm"
          multiple
          onchange={onFile}
        />
      </label>
      <div class="row">
        <input placeholder="URL of a .gfc file" bind:value={gfcUrl} /><button
          onclick={fetchGfc}
          disabled={!gfcUrl}
        >
          Fetch
        </button>
      </div>
    </section>

    <section>
      <h2>Ellipsoid</h2>
      <select bind:value={datum}>
        {#each ELLIPSOIDS as e, i}<option value={String(i)}>
            {e.name}
          </option>{/each}
        <option value="custom">Custom…</option>
      </select>
      {#if datum === "custom"}
        <label>
          Semi-major axis a (m) <input
            type="number"
            step="any"
            bind:value={customA}
          />
        </label>
        <label>
          Inverse flattening 1/f <input
            type="number"
            step="any"
            bind:value={customInvF}
          />
        </label>
        {#if !ell}<p class="warn">Needs a &gt; 1 000 km and 1/f &gt; 1.</p>{/if}
      {/if}
      {#if ell}<p class="hint">
          a = {ell.a} m · f = {(1 / ell.invF).toExponential(6)}
        </p>{/if}
    </section>

    <section>
      <h2>3D view</h2>
      <Select label="Show" bind:value={show} options={SHOW_OPTIONS} />
      <label>
        Colour layer <select bind:value={layer}>
          <option value="geoid">Geoid − ellipsoid height</option><option
            value="dem"
            disabled={!demLoaded}
          >
            DEM elevation
          </option>
        </select>
      </label>
      <Slider
        label={`Vertical exaggeration: ×${Math.round(10 ** exagLog[layer])}`}
        min="0"
        max="5"
        step="0.05"
        bind:value={exagLog[layer]}
        labelPosition="top"
        showOutput={false}
      />
      <CheckBox bind:checked={removeMean}>
        Exaggerate deviation from mean
      </CheckBox>

      <div class="bar" style:background={rampCss(rampDef, reverseRamp)}></div>
      <div class="scale">
        <span>{range.min.toFixed(1)} m</span><span>
          {range.max.toFixed(1)} m
        </span>
      </div>
      <RampSelect bind:rampId />
      <CheckBox bind:checked={reverseRamp}>Reverse ramp</CheckBox>
      <CheckBox bind:checked={showBorders}>Country borders</CheckBox>
      <CheckBox bind:checked={showGraticule}>Graticule (15°)</CheckBox>
      <CheckBox bind:checked={showExtremes} style="width:auto">
        Min / max markers
      </CheckBox>
    </section>

    <section>
      <h2>Height difference map</h2>
      <Select bind:value={projection} options={PROJECTION_OPTION} />
      <canvas bind:this={mapCanvas} width="720" height="360"></canvas>
      <div class="scale">
        <span>{gRange.min.toFixed(1)} m</span><span>
          {gRange.max.toFixed(1)} m
        </span>
      </div>
    </section>

    <section>
      <h2>DEM sources</h2>
      {#each dems as s}<div class="row">
          <span class="grow">{s.name}</span><button onclick={() => useDem(s)}>
            Load
          </button>
        </div>{/each}
      <details>
        <summary>Add a source</summary>
        <input placeholder="Name" bind:value={form.name} />
        <Select bind:value={form.kind} options={DEM_FETCH_OPTIONS} />
        <input
          placeholder={form.kind === "wms"
            ? "WMS endpoint URL"
            : "https://…/{z}/{x}/{y}.png"}
          bind:value={form.url}
        />
        {#if form.kind === "wms"}<input
            placeholder="Layer name(s)"
            bind:value={form.layers}
          />{:else}<label>
            Zoom (0–4) <input
              type="number"
              min="0"
              max="4"
              bind:value={form.zoom}
            />
          </label>{/if}
        <Select bind:value={form.encoding} options={DEM_BAND_OPTIONS} />
        {#if form.encoding === "gray"}<div class="row">
            <input
              type="number"
              bind:value={form.grayMin}
              title="Metres at black"
            /><input
              type="number"
              bind:value={form.grayMax}
              title="Metres at white"
            />
          </div>{/if}
        <button onclick={addDem}>Add and load</button>
        <p class="hint">The server must send CORS headers.</p>
      </details>
    </section>
    <p class="status">{status}{tileMessage ? ` · ${tileMessage}` : ""}</p>
  </aside>
  <div class="viewport">
    <div class="canvas-host" bind:this={host}></div>
    <div class="readout">
      <div>{hover ? formatLatLon(hover) : "Hover over the globe"}</div>
      {#if info}
        <div class="picked">
          <strong>{formatLatLon(info)}</strong>
          {#if layer === "geoid"}
            <div>Geoid − ellipsoid: {formatMeter(info.N)}</div>
          {:else}
            <div>Elevation (MSL): {formatMeter(info.msl)}</div>
            <div>Height above ellipsoid (HAE): {formatMeter(info.hae)}</div>
            <div>MSL − HAE: {formatMeter(-info.N)}</div>
          {/if}
        </div>
      {:else}
        <div class="hint">Click a point for details</div>
      {/if}
      {#if showExtremes && extremes}
        <div class="picked">
          <div>
            <span style="color:#facc15">▲</span> Max {formatMeter(
              extremes.max.value,
            )} at {formatLatLon(extremes.max)}
          </div>
          <div>
            <span style="color:#38bdf8">▼</span> Min {formatMeter(
              extremes.min.value,
            )} at {formatLatLon(extremes.min)}
          </div>
        </div>
      {/if}
    </div>
  </div>
</main>

<style>
  .canvas-host {
    position: absolute;
    inset: 0;
  }

  main {
    display: grid;
    grid-template-columns: 22rem 1fr;
    height: 100%;
  }

  aside {
    overflow-y: auto;
    padding: var(--size-lg);
    background: var(--color-panel);
    border-right: 1px solid var(--color-line);
  }

  .viewport {
    position: relative;
    min-width: 0;
  }

  .viewport :global(canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .bar {
    height: 0.5rem;
    border-radius: var(--size-xs);
  }

  .readout {
    position: absolute;
    left: 1rem;
    bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: var(--size-xs);
    padding: var(--size-lg);
    background: var(--color-bg);
    border: 1px solid var(--color-edge);
    border-radius: 4px;
    font-size: var(--text-xs);
    line-height: 1.5;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .picked {
    border-top: 1px solid var(--color-edge);
  }
</style>
