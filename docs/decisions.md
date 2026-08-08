# Strata — Decisions Register
**Status:** all entries **Proposed** (recommendations awaiting author sign-off) unless marked Accepted
**Date:** 2026-08-08 (D1/D2/D6/D8 revised same day after the client-only question — see D1 history)

Numbered to match requirements §12. Each entry records the position the [technical plan](plan.md) currently assumes, so reversing one shows exactly what has to change. Decisions D1, D2 and D7 gate Phase 0; the rest bind later phases.

---

## D1 — Architecture split: client-only, no server, no database (gates Phase 0)

**Position: Strata is a static PWA plus scheduled GitHub Actions. Nothing else runs anywhere.**

**History:** v1 of this register recommended a thin server proxy. Re-examined when the author asked whether client-only was possible, the proxy's four supporting arguments dissolve for a single-operator instrument (full table in plan §1.1): rate limiting fits in the query-engine worker with Web Locks across tabs; scheduled health checks move to an Actions cron committing status to the repo; API keys become bring-your-own-key in localStorage instead of secrets behind a proxy; and CORS — the one argument that survives — is a per-layer data problem, not an architecture problem, handled by a three-step mitigation ladder (accept the loss → materialize via Actions → a single stateless CORS shim as a named last resort, built only when a specific layer forces it).

**What client-only buys:** zero hosting and zero operations; PWA offline as a natural consequence rather than a fight (D6); perfect fit with the requirements' own observation that adapters A1–A4/A6 are stateless and on-demand; an app anyone can open from a URL with their own keys.

**Honest costs, accepted knowingly** (plan §1.2): some sources are CORS-blocked and will be dropped or materialized; A5 streams are live-while-watching only (see D8); R7.5's User-Agent identification is unsatisfiable from a browser and is proposed for amendment (plan §5).

**Reversal triggers are named in plan §9** — most importantly: if browser COG reading proves broadly infeasible at milestone M0.3, D1 reverts to the v1 proxy design in week one, not month six.

## D2 — Storage: browser storage + git; no archive (gates Phase 0)

**Position: IndexedDB for the result/COG-chunk cache, localStorage for keys and settings, and the git repo itself for health-status history. No database anywhere.** Retaining historical *values* is declined, as before — it is the significant scope change §12.2 says it is. The revisit trigger ("what did the river gauge do last week") now lands at the M3.6 backend checkpoint, since an archive is precisely the kind of standing observer that client-only cannot host. Every envelope already carries `fetchedAt`, so nothing forecloses it.

## D3 — Composition: emergent now, don't foreclose

**Position: composition stays an emergent property of toggling overlays through Phase 2.** First-class composition is real complexity (cross-layer expression model, unit reconciliation, synchronized time) bolted on before the layers it would compose exist. The cheap insurance is taken instead: all results flow through one typed envelope with declared units and aggregation — exactly the substrate a composition engine would need. Reassess at Phase 3 exit.

## D4 — P2000 / emergency dispatch: out of catalogue

**Position: do not build.** Near-real-time emergency dispatches mapped to addresses is the one catalogue entry whose failure mode involves real people at the worst moment of their day, and the requirements themselves flag it as ethically thorny. A curiosity instrument does not need it; nothing else depends on it. Removed from the working catalogue rather than left latent. Revisit only with an explicit written policy (delay, aggregation, incident-type filtering) — the §12.4 "decide before building" bar, kept.

## D5 — Archaeological precision: display, honestly labelled

**Position: show fuzzed heritage locations, and make the fuzzing itself visible.** The data is published fuzzed by the responsible authorities — displaying it adds no looting risk beyond the publisher's own decision, and hiding it loses a good layer. Mechanism: descriptor field `location_precision: exact | fuzzed | centroid` (mandatory for heritage-domain layers), rendered as an area/blur symbol rather than a pin, with the provenance note stating the imprecision is deliberate. Never render a fuzzed record as an exact point.

## D6 — Offline: a natural consequence, phased deliberately

**Position: the PWA architecture makes offline a gradient, not a feature to bolt on — but it is still built in stages, not in Phase 0.** Stage 1 (free with D1): app shell and cached results work offline via service worker + IndexedDB. Stage 2 (Phase 2): "region pack" pre-localisation — download COG windows, PMTiles, and region packs for an area before a trip; descriptor `endpoint` is just a URL, so local/self-hosted assets need no code changes. Stage 3 (only if field use demands): offline handling for A1/A3 live layers, which degrades to cached-with-age-labels. The standing constraint from v1 remains: no CDN-only dependencies, all assets self-containable.

## D7 — Attribution: both surfaces (gates Phase 0)

**Position: per-result attribution line in each panel *and* an aggregate credits page.** The envelope carries attribution on every result (plan §4.2), so the panel line is nearly free; the credits page is generated from loaded descriptors, so it is *actually* free and always complete. R6.2 guarantees no layer can exist without its credit recorded.

## D8 — Aircraft feed: own receiver feeding a community aggregator (binds at Phase 3)

**Position: run an RTL-SDR receiver and feed adsb.lol / adsb.fi / airplanes.live, using the elevated API access feeders receive (as a BYOK key, per D1).** This resolves both sides of §12.8: local line-of-sight coverage with zero terms, wide-area coverage through the feeder tier, and standing on the right side of the volunteer-economy exchange. OpenSky remains the fallback if hardware doesn't happen. **Verify feeder-tier terms at Phase 3 start, not now.**

**Client-only caveat:** with no standing process, aircraft are live-while-watching; the derived ADS-B analytics of requirements §9.5 (runway-in-use, holding patterns, transponder gaps) additionally require the M3.6 backend checkpoint to conclude "yes, run a home box". The receiver hardware itself is unaffected — it feeds the aggregator regardless of whether Strata has a backend.

## D9 — Prototype salvage: concepts yes, code no — with one audition

**Position: default is rewrite; nothing is ported silently.** The flight-radar prototype's map/render approach is *reference material* for the MapLibre client (M0.7 is small enough that porting saves nothing); its ADS-B decode path gets one time-boxed audition **at Phase 3 (M3.2)** — evaluated against the A5 adapter contract like any third-party library, taken only if it fits without bespoke-code leakage (R6.1 applies to salvage too). Any lifted piece gets a provenance note in the commit.

---

## Consequences summary

| Decision | Phase it binds | If reversed, what changes |
|---|---|---|
| D1 client-only | 0 | Revert to plan v0.1's proxy (preserved in git history); core contracts and descriptors survive intact — the `IO` seam exists precisely so this reversal is contained |
| D2 no archive | 0 (cache tech), 3 (scope) | M3.6 checkpoint adds a home box + retention design; envelope survives |
| D3 emergent composition | 3+ | New expression layer over the envelope; envelope itself survives |
| D4 no P2000 | 4 | Requires written policy first; A5 adapter unaffected |
| D5 show fuzzed | 1+ | Drop layers or drop the precision field; small |
| D6 staged offline | 2+ | Pull stage 2 earlier or drop stage 3; adapters unaffected |
| D7 both attributions | 0 | Trivial either direction |
| D8 own receiver + aggregator | 3 | Descriptor endpoint + key swap; A5 adapter unaffected |
| D9 no silent ports | 0 (policy), 3 (audition) | None structural |
