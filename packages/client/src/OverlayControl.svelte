<script lang="ts">
  import type { LayerSummary } from '@strata/core';

  let {
    layer,
    onChange,
  }: {
    layer: LayerSummary & { overlay: NonNullable<LayerSummary['overlay']> };
    onChange: (layer: LayerSummary, enabled: boolean, opacity: number) => void;
  } = $props();

  const overlay = $derived(layer.overlay);
  let enabled = $state(false);
  let opacity = $state(0.65);

  $effect(() => {
    if (!enabled) opacity = overlay.opacity;
  });

  function toggle(event: Event): void {
    enabled = (event.currentTarget as HTMLInputElement).checked;
    onChange(layer, enabled, opacity);
  }

  function changeOpacity(event: Event): void {
    opacity = Number((event.currentTarget as HTMLInputElement).value);
    onChange(layer, enabled, opacity);
  }
</script>

<div class="overlay-control" class:active={enabled}>
  <label class="toggle">
    <input type="checkbox" checked={enabled} onchange={toggle} />
    <span>{layer.name}</span>
  </label>

  {#if enabled}
    <label class="opacity">
      <span>Opacity <output>{Math.round(opacity * 100)}%</output></span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={opacity}
        aria-label={`${layer.name} opacity`}
        oninput={changeOpacity}
      />
    </label>

    {#if overlay.legend}
      <div class="legend" aria-label={`${layer.name} legend`}>
        <strong>{overlay.legend.title}</strong>
        <div class="legend-items">
          {#each overlay.legend.items as item (item.label)}
            <span><i style={`background:${item.color}`}></i>{item.label}</span>
          {/each}
        </div>
      </div>
    {/if}

    <div class="attribution">
      {#if layer.attribution.url}
        <a href={layer.attribution.url} target="_blank" rel="noreferrer">{layer.attribution.text}</a>
      {:else}
        {layer.attribution.text}
      {/if}
    </div>
  {/if}
</div>

<style>
  .overlay-control {
    border: 1px solid #2c333c;
    border-radius: 7px;
    padding: 0.5rem 0.6rem;
    background: #191d23;
  }
  .overlay-control.active {
    border-color: #56677a;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  input {
    accent-color: #4d9de0;
  }
  .opacity {
    display: grid;
    gap: 0.15rem;
    margin-top: 0.55rem;
    color: #9aa3ad;
    font-size: 0.75rem;
  }
  .opacity span {
    display: flex;
    justify-content: space-between;
  }
  .opacity input {
    width: 100%;
  }
  .legend {
    margin-top: 0.5rem;
    border-top: 1px dashed #2c333c;
    padding-top: 0.45rem;
    color: #9aa3ad;
    font-size: 0.72rem;
  }
  .legend-items {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.25rem 0.5rem;
    margin-top: 0.3rem;
  }
  .legend-items span {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .legend-items i {
    width: 0.7rem;
    height: 0.7rem;
    flex: none;
    border: 1px solid rgb(255 255 255 / 45%);
    border-radius: 2px;
  }
  .attribution {
    margin-top: 0.4rem;
    color: #6a747e;
    font-size: 0.68rem;
  }
  .attribution a {
    color: #7ab8f5;
  }
</style>
