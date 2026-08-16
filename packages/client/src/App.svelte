<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { onMount } from 'svelte';
  import type { LayerResult, LayerSummary, LonLat } from '@strata/core';
  import { WorkerQueryEngine } from './worker-engine';
  import LayerPanel from './LayerPanel.svelte';
  import ApiKeySettings from './ApiKeySettings.svelte';

  const build = __BUILD_INFO__;
  const builtAt = new Date(build.date);
  const engine = new WorkerQueryEngine();

  let mapContainer: HTMLDivElement;
  let layers = $state<LayerSummary[]>([]);
  let target = $state<LonLat | null>(null);
  let zoom = $state(12);
  let epoch = $state(0);
  let showSettings = $state(false);
  let mapError = $state<string | null>(null);
  let mappedLayers = $state<Record<string, { name: string; count: number; color: string }>>({});
  let map: maplibregl.Map | undefined;

  const overlayData = new Map<string, { layer: LayerSummary; features: GeoJSON.Feature<GeoJSON.Point>[] }>();
  const DOMAIN_COLORS: Partial<Record<LayerSummary['domain'], string>> = {
    built: '#35a7ff',
    energy: '#f5a742',
    subsurface: '#9b7ede',
  };

  function overlayIds(layerId: string): { source: string; circles: string } {
    return {
      source: `strata-features-${layerId}`,
      circles: `strata-features-${layerId}-circles`,
    };
  }

  function isPointFeature(value: unknown): value is GeoJSON.Feature<GeoJSON.Point> {
    if (typeof value !== 'object' || value === null) return false;
    const feature = value as { type?: unknown; geometry?: { type?: unknown; coordinates?: unknown } | null };
    const coordinates = feature.geometry?.coordinates;
    return (
      feature.type === 'Feature' &&
      feature.geometry?.type === 'Point' &&
      Array.isArray(coordinates) &&
      coordinates.length >= 2 &&
      coordinates.slice(0, 2).every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    );
  }

  function syncFeatureOverlay(layerId: string): void {
    const currentMap = map;
    const overlay = overlayData.get(layerId);
    if (!currentMap || !overlay || !currentMap.isStyleLoaded()) return;
    const ids = overlayIds(layerId);
    const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: overlay.features,
    };
    const source = currentMap.getSource(ids.source);
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(data);
      return;
    }
    currentMap.addSource(ids.source, { type: 'geojson', data });
    currentMap.addLayer({
      id: ids.circles,
      type: 'circle',
      source: ids.source,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8],
        'circle-color': DOMAIN_COLORS[overlay.layer.domain] ?? '#35a7ff',
        'circle-opacity': 0.9,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
  }

  function showResultOnMap(layer: LayerSummary, result: LayerResult): void {
    const features = result.status === 'ok' && result.value.kind === 'features'
      ? result.value.features.filter(isPointFeature)
      : [];
    overlayData.set(layer.id, { layer, features });
    syncFeatureOverlay(layer.id);
    if (features.length === 0) {
      const next = { ...mappedLayers };
      delete next[layer.id];
      mappedLayers = next;
      return;
    }
    mappedLayers = {
      ...mappedLayers,
      [layer.id]: {
        name: layer.name,
        count: features.length,
        color: DOMAIN_COLORS[layer.domain] ?? '#35a7ff',
      },
    };
  }

  function clearMappedFeatures(): void {
    for (const [layerId, overlay] of overlayData) {
      overlay.features = [];
      syncFeatureOverlay(layerId);
    }
    mappedLayers = {};
  }

  onMount(() => {
    const mountedMap = new maplibregl.Map({
      container: mapContainer,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [16.37, 48.21],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map = mountedMap;
    mountedMap.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    // A silently gray basemap violates our own R5.2 — say what failed.
    mountedMap.on('error', (e) => {
      const msg = e.error?.message ?? 'unknown map error';
      console.error('map error:', e.error);
      if (!mapError) mapError = msg;
    });
    mountedMap.on('load', () => {
      mapError = null;
      for (const layerId of overlayData.keys()) syncFeatureOverlay(layerId);
    });
    let marker: maplibregl.Marker | undefined;
    mountedMap.on('click', (e) => {
      clearMappedFeatures();
      target = [e.lngLat.lng, e.lngLat.lat];
      epoch++;
      marker?.remove();
      marker = new maplibregl.Marker({ color: '#e8a33d' }).setLngLat(e.lngLat).addTo(mountedMap);
    });
    mountedMap.on('moveend', () => {
      zoom = Math.round(mountedMap.getZoom());
    });
    void engine.layers().then((l) => (layers = l));
    return () => {
      mountedMap.remove();
      if (map === mountedMap) map = undefined;
    };
  });
</script>

<div class="app">
  <div class="map" bind:this={mapContainer}>
    {#if mapError}
      <div class="map-error" role="alert">basemap failed to load: {mapError}</div>
    {/if}
    {#if Object.keys(mappedLayers).length > 0}
      <div class="map-feature-summary" role="status" aria-live="polite">
        {#each Object.entries(mappedLayers) as [id, mapped] (id)}
          <span><i style={`background:${mapped.color}`}></i>{mapped.count} map {mapped.count === 1 ? 'point' : 'points'} · {mapped.name}</span>
        {/each}
      </div>
    {/if}
  </div>

  <aside class="side" aria-label="Layer results and settings">
    <header>
      <h1>Strata</h1>
      <button
        class="gear"
        onclick={() => (showSettings = !showSettings)}
        aria-label="Settings"
        aria-expanded={showSettings}
        aria-controls="settings-panel"
      >⚙</button>
    </header>

    {#if target}
      <div class="coords">{target[1].toFixed(5)}, {target[0].toFixed(5)} · z{zoom}</div>
      <div class="stack">
        {#each layers as layer (layer.id)}
          <LayerPanel {engine} {layer} {target} {zoom} {epoch} onResult={showResultOnMap} />
        {/each}
      </div>
    {:else}
      <p class="hint">Click anywhere on the map to ask: <em>what can I find out about this place?</em></p>
      {#if layers.length > 0}
        <p class="hint dim">{layers.length} layers loaded.</p>
      {/if}
    {/if}

    {#if showSettings}
      <div class="settings" id="settings-panel">
        <h2>Settings</h2>
        <dl>
          <dt>Build</dt>
          <dd>#{build.number} <code>({build.sha})</code></dd>
          <dt>Built at</dt>
          <dd><time datetime={build.date}>{builtAt.toUTCString()}</time></dd>
        </dl>
        <p class="hint dim">
          Build number not matching the latest
          <a href="https://github.com/gergol/strata/actions/workflows/pages.yml" target="_blank" rel="noreferrer">deploy</a>?
          Hard-reload (Ctrl/Cmd&#8288;+&#8288;Shift&#8288;+&#8288;R).
        </p>
        <ApiKeySettings />
        <h2>Data credits</h2>
        <ul class="credits">
          {#each layers as layer (layer.id)}
            <li>
              <strong>{layer.name}</strong> —
              {#if layer.attribution.url}<a href={layer.attribution.url} target="_blank" rel="noreferrer">{layer.attribution.text}</a>{:else}{layer.attribution.text}{/if}
            </li>
          {/each}
        </ul>
        <p class="hint dim">Basemap © <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></p>
      </div>
    {/if}

    <footer>build #{build.number} · {build.sha}</footer>
  </aside>
</div>

<style>
  :global(html, body, #app) {
    margin: 0;
    height: 100%;
  }
  :global(body) {
    font-family: system-ui, sans-serif;
    background: #14171c;
    color: #e6e8eb;
  }
  .app {
    display: flex;
    height: 100%;
  }
  .map {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  .map-error {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    right: 3rem;
    z-index: 10;
    background: #4a2020;
    color: #e8b4b4;
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
  }
  .map-feature-summary {
    position: absolute;
    left: 0.6rem;
    bottom: 0.6rem;
    z-index: 5;
    display: grid;
    gap: 0.2rem;
    max-width: min(24rem, calc(100% - 4rem));
    border: 1px solid #343c47;
    border-radius: 6px;
    background: rgb(20 23 28 / 90%);
    color: #d7dce2;
    padding: 0.35rem 0.5rem;
    font-size: 0.75rem;
  }
  .map-feature-summary span {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .map-feature-summary i {
    width: 0.65rem;
    height: 0.65rem;
    flex: none;
    border: 1px solid #fff;
    border-radius: 50%;
  }
  .side {
    width: min(26rem, 90vw);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem;
    overflow-y: auto;
    border-left: 1px solid #2c333c;
    background: #14171c;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h1 {
    margin: 0;
    font-size: 1.2rem;
  }
  h2 {
    font-size: 0.9rem;
    margin: 0.75rem 0 0.25rem;
  }
  .gear {
    all: unset;
    cursor: pointer;
    font-size: 1.1rem;
    color: #9aa3ad;
  }
  .gear:focus-visible {
    outline: 2px solid #7ab8f5;
    outline-offset: 3px;
    border-radius: 3px;
  }
  .coords {
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    color: #9aa3ad;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .hint {
    color: #9aa3ad;
    font-size: 0.9rem;
  }
  .hint.dim {
    color: #5c6670;
    font-size: 0.78rem;
  }
  .settings {
    border-top: 1px solid #2c333c;
    padding-top: 0.5rem;
    font-size: 0.85rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 0.8rem;
    margin: 0.25rem 0;
  }
  dt {
    color: #9aa3ad;
  }
  dd {
    margin: 0;
  }
  .credits {
    margin: 0.25rem 0;
    padding-left: 1.1rem;
    font-size: 0.8rem;
    color: #c4cad2;
  }
  a {
    color: #7ab8f5;
  }
  footer {
    margin-top: auto;
    padding-top: 0.5rem;
    color: #5c6670;
    font-size: 0.72rem;
    border-top: 1px solid #2c333c;
  }
  @media (max-width: 700px) {
    .app {
      flex-direction: column;
    }
    .map {
      height: 45vh;
      flex: none;
    }
    .side {
      width: auto;
      border-left: none;
      border-top: 1px solid #2c333c;
      flex: 1;
    }
  }
</style>
