<script lang="ts">
  import type { LayerResult, LayerSummary, LonLat, QueryEngine } from '@strata/core';
  import { lonLatToTile } from '@strata/core/tile';

  let {
    engine,
    layer,
    target,
    zoom,
    epoch,
    onResult,
  }: {
    engine: QueryEngine;
    layer: LayerSummary;
    target: LonLat;
    zoom: number;
    epoch: number;
    onResult?: (layer: LayerSummary, result: LayerResult) => void;
  } = $props();

  let expanded = $state(false);
  let loading = $state(false);
  let result = $state<LayerResult | null>(null);
  let areaResult = $state<LayerResult | null>(null);
  let areaLoading = $state(false);

  const BASIS_LABEL: Record<string, string> = {
    aggregated: 'aggregated',
    sampled: 'sampled — probe grid, not a statistic',
    nearest: 'nearest — searched around the point',
  };
  const ERROR_LABEL: Record<string, string> = {
    upstream: 'upstream error',
    timeout: 'timeout',
    schema: 'unexpected response shape',
    rate_limited: 'rate limited',
    circuit_open: 'paused after repeated failures',
    cors: 'blocked by browser CORS policy',
  };

  // Lazy fetch (R7.1): the query runs only while the panel is expanded, and
  // re-runs when the target point changes (epoch).
  $effect(() => {
    void epoch;
    if (!expanded) return;
    let active = true;
    areaResult = null;
    loading = true;
    engine
      .point(layer.id, target)
      .then((r) => {
        if (!active) return;
        result = r;
        onResult?.(layer, r);
      })
      .catch((e: Error) => {
        if (!active) return;
        result = { status: 'error', kind: 'upstream', message: e.message };
        onResult?.(layer, result);
      })
      .finally(() => {
        if (active) loading = false;
      });
    return () => {
      active = false;
    };
  });

  function queryArea(): void {
    areaLoading = true;
    engine
      .tile(layer.id, lonLatToTile(target, zoom))
      .then((r) => (areaResult = r))
      .catch((e: Error) => (areaResult = { status: 'error', kind: 'upstream', message: e.message }))
      .finally(() => (areaLoading = false));
  }

  const fmt = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ''));
  const fmtSourceTime = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  const featureName = (f: unknown): string => {
    const p = (f as { properties?: Record<string, string> }).properties ?? {};
    return p['name'] ?? p['amenity'] ?? p['osm_type'] ? `${p['name'] ?? p['amenity'] ?? 'feature'} (${p['osm_type'] ?? ''} ${p['osm_id'] ?? ''})` : 'feature';
  };
</script>

{#snippet envelope(r: LayerResult)}
  {#if r.status === 'ok'}
    {#if r.value.kind === 'scalar'}
      <div class="value">{typeof r.value.value === 'number' ? fmt(r.value.value) : r.value.value}<span class="unit">{r.unit}</span></div>
    {:else if r.value.kind === 'histogram'}
      <div class="histogram">
        {#each r.value.classes.slice(0, 12) as c (c.label)}
          <div class="bar-row">
            <span class="bar-label">{c.label}</span>
            <div class="bar-track"><div class="bar" style={`width:${(c.share * 100).toFixed(1)}%`}></div></div>
            <span class="bar-pct">{(c.share * 100).toFixed(1)}%</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="features">
        <div class="value">{r.value.features.length}<span class="unit">found{r.value.truncated ? ' (list capped)' : ''}</span></div>
        <ul>
          {#each r.value.features.slice(0, 8) as f, i (i)}
            <li>{featureName(f)}</li>
          {/each}
        </ul>
      </div>
    {/if}
    <div class="meta">
      <span class="chip">{r.aggregation}</span>
      <span class="chip" class:warn={r.basis !== 'aggregated'}>{BASIS_LABEL[r.basis]}</span>
      {#if r.region}<span class="chip">region: {r.region.toUpperCase()}</span>{/if}
      {#if r.sourceUpdatedAt}<span class="chip">source: <time datetime={r.sourceUpdatedAt}>{fmtSourceTime(r.sourceUpdatedAt)}</time></span>{/if}
      {#if r.cacheHit}<span class="chip dim">cached</span>{/if}
    </div>
    <div class="provenance">{r.provenance}</div>
    <div class="attribution">
      {#if r.attribution.url}<a href={r.attribution.url} target="_blank" rel="noreferrer">{r.attribution.text}</a>{:else}{r.attribution.text}{/if}
    </div>
  {:else if r.status === 'empty'}
    <div class="state empty">Nothing here — this dataset covers the area and reports no results. That's an answer, not an error.</div>
  {:else if r.status === 'no_coverage'}
    <div class="state nocov">No coverage — this dataset doesn't include this territory.</div>
  {:else if r.status === 'zoom_invalid'}
    <div class="state zoominv">{r.reason}</div>
  {:else if r.status === 'error'}
    <div class="state error">{ERROR_LABEL[r.kind] ?? r.kind}: {r.message}</div>
  {:else if r.status === 'degraded'}
    <div class="state error">Layer degraded: {r.reason}</div>
  {/if}
{/snippet}

<section class="panel" class:degraded={layer.degraded}>
  <button
    class="head"
    onclick={() => (expanded = !expanded)}
    aria-expanded={expanded}
    aria-controls={`panel-body-${layer.id}`}
  >
    <span class="name">{layer.name}</span>
    <span class="chips">
      {#if layer.degraded}<span class="chip error-chip" title="health check failing">degraded</span>{/if}
      <span class="chip dim">{layer.domain}</span>
      <span class="caret">{expanded ? '▾' : '▸'}</span>
    </span>
  </button>
  {#if expanded}
    <div class="body" id={`panel-body-${layer.id}`} aria-busy={loading || areaLoading}>
      {#if loading}
        <div class="state" role="status">querying…</div>
      {:else if result}
        {@render envelope(result)}
      {/if}
      {#if layer.modes.includes('tile')}
        <div class="area">
          <button class="area-btn" onclick={queryArea} disabled={areaLoading}>
            {areaLoading ? 'computing…' : `area stats (z${zoom} tile)`}
          </button>
          {#if areaResult}{@render envelope(areaResult)}{/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .panel {
    border: 1px solid #2c333c;
    border-radius: 8px;
    background: #191d23;
    overflow: hidden;
  }
  .panel.degraded {
    border-color: #7a4a1d;
  }
  .head {
    all: unset;
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem 0.75rem;
    cursor: pointer;
    font-weight: 600;
  }
  .head:hover {
    background: #1f242c;
  }
  .head:focus-visible,
  .area-btn:focus-visible {
    outline: 2px solid #7ab8f5;
    outline-offset: -2px;
  }
  .chips {
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }
  .body {
    padding: 0.25rem 0.75rem 0.75rem;
    border-top: 1px solid #2c333c;
  }
  .value {
    font-size: 1.6rem;
    font-weight: 700;
    margin: 0.35rem 0;
  }
  .unit {
    font-size: 0.9rem;
    font-weight: 400;
    color: #9aa3ad;
    margin-left: 0.4rem;
  }
  .histogram {
    margin: 0.5rem 0;
    display: grid;
    gap: 0.25rem;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 9rem 1fr 3.2rem;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.8rem;
  }
  .bar-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #c4cad2;
  }
  .bar-track {
    background: #242a33;
    border-radius: 3px;
    height: 0.65rem;
  }
  .bar {
    background: #4d9de0;
    height: 100%;
    border-radius: 3px;
  }
  .bar-pct {
    text-align: right;
    color: #9aa3ad;
  }
  .features ul {
    margin: 0.25rem 0;
    padding-left: 1.1rem;
    font-size: 0.85rem;
    color: #c4cad2;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.4rem 0;
  }
  .chip {
    font-size: 0.7rem;
    background: #242a33;
    color: #9aa3ad;
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
  }
  .chip.warn {
    background: #3d3222;
    color: #e0b35d;
  }
  .chip.dim {
    opacity: 0.7;
  }
  .error-chip {
    background: #4a2020;
    color: #e08a8a;
  }
  .caret {
    color: #5c6670;
  }
  .provenance {
    font-style: italic;
    color: #8a939d;
    font-size: 0.78rem;
  }
  .attribution {
    font-size: 0.72rem;
    color: #6a747e;
    margin-top: 0.25rem;
  }
  .attribution a {
    color: #7ab8f5;
  }
  .state {
    color: #9aa3ad;
    font-size: 0.85rem;
    padding: 0.4rem 0;
  }
  .state.empty {
    color: #7fbf7f;
  }
  .state.nocov {
    color: #b0885e;
  }
  .state.zoominv {
    color: #8a939d;
  }
  .state.error {
    color: #e08a8a;
  }
  .area {
    margin-top: 0.5rem;
    border-top: 1px dashed #2c333c;
    padding-top: 0.5rem;
  }
  .area-btn {
    all: unset;
    cursor: pointer;
    font-size: 0.78rem;
    color: #7ab8f5;
  }
  .area-btn:disabled {
    color: #5c6670;
  }
</style>
