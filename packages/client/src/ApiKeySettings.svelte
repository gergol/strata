<script lang="ts">
  import { onMount } from 'svelte';
  import { API_KEY_DEFINITIONS, apiKeyStorageKey } from './api-keys';

  let values = $state<Record<string, string>>({});
  let stored = $state<Record<string, boolean>>({});
  let message = $state('');

  onMount(() => {
    stored = Object.fromEntries(
      API_KEY_DEFINITIONS.map((definition) => [definition.id, localStorage.getItem(apiKeyStorageKey(definition.id)) !== null]),
    );
  });

  function save(id: string): void {
    const value = values[id]?.trim() ?? '';
    if (!value) {
      message = 'Enter a key before saving.';
      return;
    }
    localStorage.setItem(apiKeyStorageKey(id), value);
    values[id] = '';
    stored[id] = true;
    message = 'Key saved only in this browser.';
  }

  function remove(id: string): void {
    localStorage.removeItem(apiKeyStorageKey(id));
    values[id] = '';
    stored[id] = false;
    message = 'Key removed.';
  }
</script>

<section class="keys" aria-labelledby="api-keys-heading">
  <h2 id="api-keys-heading">API keys</h2>
  <p class="note">Optional personal keys are stored in this browser’s local storage. They are never committed or sent anywhere except to their named provider when a matching layer is used.</p>
  <div class="key-list">
    {#each API_KEY_DEFINITIONS as definition (definition.id)}
      <div class="key-row">
        <label for={`key-${definition.id}`}>
          <strong>{definition.label}</strong>
          <span>{definition.purpose}</span>
        </label>
        <div class="controls">
          <input
            id={`key-${definition.id}`}
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder={stored[definition.id] ? 'saved' : 'not configured'}
            value={values[definition.id] ?? ''}
            oninput={(event) => (values[definition.id] = event.currentTarget.value)}
          />
          <button type="button" onclick={() => save(definition.id)}>Save</button>
          {#if stored[definition.id]}<button type="button" class="remove" onclick={() => remove(definition.id)}>Remove</button>{/if}
        </div>
      </div>
    {/each}
  </div>
  <p class="status" role="status" aria-live="polite">{message}</p>
</section>

<style>
  h2 {
    font-size: 0.9rem;
    margin: 0.75rem 0 0.25rem;
  }
  .note {
    color: #8a939d;
    font-size: 0.76rem;
    line-height: 1.35;
  }
  .key-list {
    display: grid;
    gap: 0.65rem;
  }
  .key-row {
    display: grid;
    gap: 0.3rem;
  }
  label {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.8rem;
  }
  label span {
    color: #6f7984;
    text-align: right;
  }
  .controls {
    display: flex;
    gap: 0.35rem;
  }
  input {
    min-width: 0;
    flex: 1;
    border: 1px solid #343c47;
    border-radius: 5px;
    background: #101319;
    color: #e6e8eb;
    padding: 0.35rem 0.45rem;
  }
  button {
    border: 1px solid #3b4653;
    border-radius: 5px;
    background: #242a33;
    color: #c4cad2;
    cursor: pointer;
    padding: 0.3rem 0.5rem;
  }
  button.remove {
    color: #e08a8a;
  }
  input:focus-visible,
  button:focus-visible {
    outline: 2px solid #7ab8f5;
    outline-offset: 2px;
  }
  .status {
    min-height: 1rem;
    margin: 0.35rem 0 0;
    color: #7fbf7f;
    font-size: 0.75rem;
  }
</style>
