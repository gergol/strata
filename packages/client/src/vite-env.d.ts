/// <reference types="svelte" />
/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` at build time. */
declare const __BUILD_INFO__: {
  number: string;
  sha: string;
  date: string;
};

/** Raw contents of every layers/*.yaml, inlined at build time. */
declare const __LAYER_YAMLS__: string[];
