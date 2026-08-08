# Strata — Decisions Register
**Status:** all entries **Proposed** (recommendations awaiting author sign-off) unless marked Accepted
**Date:** 2026-08-08

Numbered to match requirements §12. Each entry records the position the [technical plan](plan.md) currently assumes, so reversing one shows exactly what has to change. Decisions D1, D2 and D7 gate Phase 0; the rest are recorded now but bind later phases.

---

## D1 — Architecture split: thin server proxy ✅ recommended (gates Phase 0)

**Position: build the proxy from day one.** The requirements already contain three things a pure client cannot do: enforce per-layer rate limits and circuit breakers globally rather than per browser tab (R7.3, R7.6 — and the hazards in §7 are bans, not slowdowns), run scheduled health checks independent of user activity (R8.2), and hold API keys (ENTSO-E, FIRMS, eBird) without publishing them. CORS alone would force a proxy for half the catalogue anyway. The §12.1 cost ("hosting and an extra hop") is capped by the plan's deployment target: one process, SQLite, one small box.

**Carve-out:** browser-native tile pyramids and range-readable local assets bypass the proxy (plan §1). This keeps bandwidth sane and preserves the offline option (D6).

## D2 — Storage: SQLite for cache + status history; no archive (gates Phase 0)

**Position: one SQLite file; the app remains an observer, not an archive.** The cache (R7.2) and layer status history (R8.5) are both required and both fit SQLite at single-operator scale. Retaining historical *values* is declined for now — it is the significant scope change §12.2 says it is (retention policy, storage growth, a time dimension in the UI and the envelope). Revisit as its own decision if a concrete want emerges ("what did the river gauge do last week" is the likely trigger); nothing in the envelope design forecloses it, since every result already carries `fetchedAt`.

## D3 — Composition: emergent now, don't foreclose

**Position: composition stays an emergent property of toggling overlays through Phase 2.** First-class composition is real complexity (a cross-layer expression model, unit reconciliation, synchronized time) bolted on before the layers it would compose exist. The cheap insurance is taken instead: all results flow through one typed envelope with declared units and aggregation, which is precisely the substrate a composition engine would need. Reassess at Phase 3 exit, when there are enough layers for composition to have material.

## D4 — P2000 / emergency dispatch: out of catalogue

**Position: do not build.** Near-real-time emergency dispatches mapped to addresses is the one catalogue entry whose failure mode involves real people at the worst moment of their day, and the requirements themselves flag it as ethically thorny. A curiosity instrument does not need it; nothing else in the catalogue depends on it. Remove from the working catalogue rather than leaving it as latent Phase 4 work. Revisit only with an explicit, written policy (delay, aggregation, incident-type filtering) — i.e. the §12.4 "decide before building" bar, kept.

## D5 — Archaeological precision: display, honestly labelled

**Position: show fuzzed heritage locations, and make the fuzzing itself visible.** The data is published fuzzed by the responsible authorities — displaying it adds no looting risk beyond the publisher's own decision, and hiding it just loses a good layer. Mechanism: a descriptor field `location_precision: exact | fuzzed | centroid` (mandatory for heritage-domain layers), rendered as an area/blur symbol rather than a pin, with the provenance note stating that positions are deliberately imprecise. Never render a fuzzed record as an exact point — that would be the actively misleading case.

## D6 — Offline: not designed for, deliberately not designed out

**Position: no offline work before Phase 2, but two standing constraints protect the option:** (1) COG and PMTiles access paths must work against local files / any static host, not only original upstreams — the descriptor `endpoint` is just a URL; (2) the client bundle stays self-contained (no CDN-only dependencies). The realistic offline story is "pre-localise the A2/A6 assets for a region before a trip", which is a download tool plus descriptor overrides, not an app rewrite. Full offline (service worker, cached region packs for A1/A3) is scoped only if field use actually demands it.

## D7 — Attribution: both surfaces (gates Phase 0)

**Position: per-result attribution line in each panel *and* an aggregate credits page.** The envelope carries attribution on every result (plan §4.2), so the panel line is nearly free; the credits page is generated from loaded descriptors, so it is *actually* free and always complete. Obligations are discharged even when a panel is collapsed, and R6.2 guarantees no layer can exist without its credit recorded.

## D8 — Aircraft feed: own receiver feeding a community aggregator (binds at Phase 3)

**Position: run an RTL-SDR receiver and feed adsb.lol / adsb.fi / airplanes.live, using the elevated API access feeders receive.** This is the §12.8 option that resolves both sides: local line-of-sight coverage with zero terms from the own receiver, wide-area coverage through the aggregator's feeder tier, and standing on the right side of the volunteer-economy exchange rather than being a pure consumer. OpenSky remains the fallback if hardware doesn't happen. **Verify feeder-tier terms at Phase 3 start, not now** — this is exactly the class of volunteer-service policy that drifts (§10 caveat). No Phase 0–2 work depends on this decision.

## D9 — Prototype salvage: concepts yes, code no — with one audition

**Position: default is rewrite; nothing is ported silently.** The requirements' framing (learning carries over, code does not) becomes concrete as: the flight-radar prototype's map/render approach is *reference material* when building the MapLibre client (M0.7 is small enough that porting would save nothing), and its ADS-B decode path gets one time-boxed audition **at Phase 3 start** — evaluated against the A5 adapter contract like any third-party library, and taken only if it fits the contract without bespoke-code leakage (R6.1 applies to salvage too). Any lifted piece gets a provenance note in the commit. This closes §12.9's "accidental port" drift by making the default no-port and the exception explicit.

---

## Consequences summary

| Decision | Phase it binds | If reversed, what changes |
|---|---|---|
| D1 proxy | 0 | Entire plan §1–§4; effectively a different project |
| D2 no archive | 0 (schema), later (scope) | Cache schema gains a retention dimension; UI gains time |
| D3 emergent composition | 3+ | New expression layer over the envelope; envelope itself survives |
| D4 no P2000 | 4 | Requires written policy first; A5 adapter unaffected |
| D5 show fuzzed | 1+ | Drop layers or drop the precision field; small |
| D6 no offline design | 2+ | Download tooling + service worker; adapters survive |
| D7 both attributions | 0 | Trivial either direction |
| D8 own receiver + aggregator | 3 | Descriptor endpoint swap; A5 adapter unaffected |
| D9 no silent ports | 0 (policy), 3 (audition) | None structural |
