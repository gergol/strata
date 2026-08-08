<script lang="ts">
  const build = __BUILD_INFO__;
  const builtAt = new Date(build.date);
</script>

<main>
  <header>
    <h1>Strata</h1>
    <p class="tagline">What can I find out about the place I am standing in — or the place I am looking at?</p>
  </header>

  <section class="status">
    <h2>Status</h2>
    <p>
      Phase 0 (foundations) in progress. The contracts package is done; this page is a deployment
      shell — the map client arrives with milestone M0.7. Plans and progress live in the
      <a href="https://github.com/gergol/strata">repository</a>.
    </p>
  </section>

  <details class="settings" open>
    <summary>Settings</summary>
    <dl>
      <dt>Build</dt>
      <dd>#{build.number} <code>({build.sha})</code></dd>
      <dt>Built at</dt>
      <dd><time datetime={build.date}>{builtAt.toUTCString()}</time></dd>
    </dl>
    <p class="hint">
      If this build number doesn't match the latest deploy on
      <a href="https://github.com/gergol/strata/actions/workflows/pages.yml">Actions</a>,
      hard-reload (Ctrl/Cmd&#8288;+&#8288;Shift&#8288;+&#8288;R) — the browser served a cached copy.
    </p>
  </details>

  <footer>
    <span>Strata · build #{build.number} · {build.sha}</span>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #14171c;
    color: #e6e8eb;
    line-height: 1.5;
  }
  main {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem 1rem 4rem;
  }
  h1 {
    margin-bottom: 0.25rem;
  }
  .tagline {
    color: #9aa3ad;
    font-style: italic;
    margin-top: 0;
  }
  a {
    color: #7ab8f5;
  }
  .settings {
    margin-top: 2rem;
    border: 1px solid #2c333c;
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  .settings summary {
    cursor: pointer;
    font-weight: 600;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0.75rem 0 0;
  }
  dt {
    color: #9aa3ad;
  }
  dd {
    margin: 0;
  }
  .hint {
    color: #9aa3ad;
    font-size: 0.85rem;
    margin-bottom: 0;
  }
  footer {
    margin-top: 3rem;
    color: #5c6670;
    font-size: 0.8rem;
    border-top: 1px solid #2c333c;
    padding-top: 0.75rem;
  }
</style>
