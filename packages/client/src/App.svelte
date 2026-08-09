<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { onMount } from 'svelte';
  import type { LayerSummary, LonLat } from '@strata/core';
  import { WorkerQueryEngine } from './worker-engine';
  import LayerPanel from './LayerPanel.svelte';

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

  onMount(() => {
    const map = new maplibregl.Map({
      container: mapContainer,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [16.37, 48.21],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    // A silently gray basemap violates our own R5.2 — say what failed.
    map.on('error', (e) => {
      const msg = e.error?.message ?? 'unknown map error';
      console.error('map error:', e.error);
      if (!mapError) mapError = msg;
    });
    map.on('load', () => {
      mapError = null;
    });
    let marker: maplibregl.Marker | undefined;
    map.on('click', (e) => {
      target = [e.lngLat.lng, e.lngLat.lat];
      epoch++;
      marker?.remove();
      marker = new maplibregl.Marker({ color: '#e8a33d' }).setLngLat(e.lngLat).addTo(map);
    });
    map.on('moveend', () => {
      zoom = Math.round(map.getZoom());
    });
    void engine.layers().then((l) => (layers = l));
    return () => map.remove();
  });
</script>

<div class="app">
  <div class="map" bind:this={mapContainer}>
    {#if mapError}
      <div class="map-error">basemap failed to load: {mapError}</div>
    {/if}
  </div>

  <aside class="side">
    <header>
      <h1>Strata</h1>
      <button class="gear" onclick={() => (showSettings = !showSettings)} title="settings">⚙</button>
    </header>

    {#if target}
      <div class="coords">{target[1].toFixed(5)}, {target[0].toFixed(5)} · z{zoom}</div>
      <div class="stack">
        {#each layers as layer (layer.id)}
          <LayerPanel {engine} {layer} {target} {zoom} {epoch} />
        {/each}
      </div>
    {:else}
      <p class="hint">Click anywhere on the map to ask: <em>what can I find out about this place?</em></p>
      {#if layers.length > 0}
        <p class="hint dim">{layers.length} layers loaded.</p>
      {/if}
    {/if}

    {#if showSettings}
      <div class="settings">
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
