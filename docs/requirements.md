# Strata — Requirements & Planning Document
**Status:** draft v0.3
**Date:** 2026-08-16
**Errata v0.2.1 (2026-08-08 audit):** six adapters, not five (§3); GIBS adapter code corrected to A6 (§10.2); §9 derivations are referenced as "§9, derivation *n*" (there are no §9 subsections); §6 example aligned with descriptor schema v1 — see plan §5 for the recorded deviations.
**Changed in v0.3:** overlay mode now has an explicit descriptor rendering contract, matching the first Phase 1 raster-overlay implementation.
**Name:** **Strata** — chosen over the working title "Anything-Map". The name refers to the layered structure of what the app exposes about a place, and deliberately avoids promising completeness, since coverage will be permanently uneven (see §10). "Strata" is plural; the singular "Stratum" is available if a singular reads better in UI copy.
**Author's context:** a new OSM-based general-purpose geospatial data explorer, built from scratch. A prior flight-radar prototype exists but is treated here as a source of learning only — no code, feed, or ingestion is assumed to carry over. Aircraft are one layer among many, competing for priority on the same terms as everything else.
---
## 1. Purpose and scope
### 1.1 What this is
A personal exploration instrument. The guiding question the app answers is:
> *"What can I find out about the place I am standing in — or the place I am looking at?"*
Breadth of available data is the primary feature, not a nice-to-have. This is a deliberate inversion of normal product logic: for a focused audience, a specialised app (Windy for wind, FIRMS for fire, lightpollutionmap for sky brightness) will always beat a generalist. For a single curious operator, no focused app can answer the question above, because the question spans domains. Breadth is therefore the whole point.
### 1.2 What this is not
- Not a commercial product. No monetisation is planned.
- Not an attempt to out-render Windy, out-analyse ENTSO-E dashboards, or replace any specialist tool.
- Not a "best-in-class visualisation of one dataset" project.
### 1.3 Consequences of 1.1 / 1.2
- **Non-commercial-only licences are acceptable** (Tankerkönig, Blitzortung, ACLED academic terms). They must still be recorded per layer, because the cost of retrofitting licence metadata later is high and the cost of recording it now is near zero.
- Attribution obligations must be discharged correctly regardless of commercial status.
- Adding layers must be cheap. Any layer that requires bespoke code rather than configuration is a design smell to be fixed at the adapter level.
### 1.4 Non-goals / explicitly deferred
- GRIB2 decoding and WebGL particle-field advection ("Windy-style" animated wind). This is a substantial project in its own right — field decoding, regridding, vector tiling, shader work — not a layer. Point forecasts (Open-Meteo) deliver most of the value at ~1% of the effort. Revisit only after the core is stable.
- Multi-user features, accounts, sharing, sync.
- Mobile-native clients (assume responsive web unless decided otherwise).
---
## 2. Interaction modes
Three distinct query modes, each with different semantics. A layer may support one, two, or all three.
| Mode | Trigger | Question answered | Notes |
|---|---|---|---|
| **M1 — Point ("here")** | Current GPS location, or map click/crosshair | "What is true at this exact coordinate?" | The primary mode. Presented as a scrollable stack of answers about one coordinate. |
| **M2 — Tile / viewport** | Current visible extent, or an explicit tile | "What is present or aggregate across this area?" | Requires per-layer aggregation semantics (§4). Validity is zoom-dependent. |
| **M3 — Continuous overlay** | Layer toggled on | Visual rendering across the map | Raster tiles or vector features. No aggregation needed. |
**Key requirement:** M2 must not be implemented as a generic function over M1. "The value for this tile" is a well-defined question for only a minority of layers. See §4.
---
## 3. Architecture — six access adapters
Every data source encountered in research collapses into one of six adapters. Building these six well is what makes breadth affordable; each new layer then becomes configuration.
### A1 — BBOX-native vector
Endpoint accepts a bounding box, returns features. A tile *is* a bbox, so M2 is native.
Covers: Overpass, all INSPIRE WFS services (cadastre, hazard zones, Natura 2000), USGS earthquakes, NASA FIRMS, GBIF, eBird, OpenAQ, Wikidata SPARQL with geo filter.
Aggregation: count, density, or capped feature list.
### A2 — COG raster
Cloud-Optimized GeoTIFF read via HTTP range requests against the overview level matching current zoom. Reads only the bytes covering the region of interest.
**Preferred over WMS wherever both exist.** WMS returns rendered PNG (colour, not value) and `GetFeatureInfo` is point-only by specification. COG returns actual pixel values, enabling real statistics.
Covers: SoilGrids, Copernicus DEM, WorldCover, CORINE, GHSL, ESHM20, VIIRS light pollution, national LiDAR DTM/DSM.
Aggregation: class histogram (categorical) or min/mean/max/percentiles (continuous). No API key, no rate limit.
### A3 — Region lookup
Data is keyed to administrative or bespoke units, not coordinates. Adapter resolves geometry → intersecting region polygons (held locally; small and stable) → fetch by region ID.
Covers: Eurostat/NUTS-LAU indicators, election results, EAWS avalanche warning regions, pharmacy on-call districts, DSO outage territories, municipality-level EPC and property aggregates, EDO drought at NUTS level.
This adapter converts a large tranche of apparently un-tileable European data into tileable data. Under-appreciated; build it early.
### A4 — Point sample
For genuine per-location model runs with no bulk form. Sample centroid plus a small grid (3×3 or 5×5), cache hard by tile ID.
Covers: PVGIS, MET Norway Locationforecast, `GetFeatureInfo`-only endpoints.
**Requirement:** results from this adapter must be visually distinguished in the UI as *sampled*, not *aggregated*. A "mean" of 9 probes across a 10 km tile is not a statistic and must not be presented as one.
### A5 — Stream
Long-lived connection feeding a local state buffer; a query is then a spatial index lookup over that buffer. Once ingestion exists, marginal query cost is zero and it works at any zoom.
Covers: ADS-B, AIS, APRS, EMSC WebSocket, GTFS-RT after local indexing.
**Note:** this is the only adapter with significant standing infrastructure cost — it needs a persistent process, a state store with expiry, and reconnect/backfill handling. Unlike A1–A4 it cannot be driven purely on demand from the client, which is a strong argument for the server-side proxy in §12.1.
### A6 — Precomputed / already tile-shaped
Special case requiring no query logic at all — a local join.
Covers: Ookla open speed data (keyed by z16 quadkey), Kontur population (H3 hexes), regular population grids (Eurostat GISCO, GHSL, WorldPop).
---
## 4. Aggregation semantics — the critical requirement
**Aggregation is a per-layer declaration, not a generic function.** This is the single most important design decision in the project; getting it wrong is what turns broad map apps into mush.
Illustrative failure cases:
- *Geology for this tile.* Modal bedrock unit, or area-weighted proportions of all units present? Both defensible; they answer different questions, and the modal answer is actively misleading in a fault zone.
- *Air quality for this tile.* Mean of contained sensors, max, or nearest to centre? At z9 there are 400 sensors and the mean is meaningless. At z14 there are zero, and reaching outside the tile means it is no longer a tile query.
### 4.1 Requirements
- R4.1 Each layer declares exactly one primary aggregation function, plus optional secondaries.
- R4.2 The declared aggregation is surfaced in the UI (at minimum on hover/expand), so the user always knows what number they are reading.
- R4.3 Categorical rasters aggregate to a class histogram, not a single label, unless the layer explicitly declares modal-with-confidence.
- R4.4 Sparse point layers declare whether they may search beyond the tile boundary, and if so the result is labelled as *nearest*, not *contained*.
---
## 5. Zoom validity and empty states
### 5.1 Zoom validity
- R5.1 Each layer declares `zoom_valid: [min, max]` — the range in which the query is **semantically** valid, not merely technically possible.
- R5.2 Outside that range the UI greys the layer out with a reason. Silent garbage is forbidden.
Examples: soil pH at z6 is a 600 km-wide average of a continent. Parcel boundaries at z10 are millions of polygons. A city tree cadastre at z8 will return every tree in Vienna and kill the renderer.
### 5.2 Empty states must be distinguished
- R5.3 The system distinguishes at least three outcomes, and renders them differently:
  1. **No coverage** — the dataset does not include this territory (a gap in the app).
  2. **Coverage, zero results** — the dataset covers here and there is genuinely nothing (this is information).
  3. **Query failed** — endpoint error, timeout, schema mismatch.
For a curiosity tool the distinction between (1) and (2) matters enormously and is frequently conflated.
---
## 6. Layer descriptor — the configuration contract
The core abstraction. Get the shape right on the first three layers and the remaining ~70 become configuration rather than code.
```yaml
id: soilgrids_ph
name: Soil pH (0–5 cm)
domain: subsurface
adapter: cog                  # bbox_vector | cog | region | point_sample | stream | precomputed
endpoint: https://files.isric.org/soilgrids/latest/data/phh2o/phh2o_0-5cm_mean.vrt
crs: EPSG:152160              # native CRS; reprojection is the adapter's job
modes: [point, tile, overlay]
zoom_valid: [10, 18]
value_type: numeric           # numeric | categorical | feature — decides which rules below bind
aggregation:
  primary: mean
  secondary: [min, max, p10, p90]
unit: pH                      # display unit, after scale_factor is applied
native_unit: "pH*10"          # upstream's raw unit — a frequent source of silent error
scale_factor: 0.1
ttl: 30d                      # geology never changes; air quality is hourly; ADS-B is per-second
rate_limit:
  max_concurrent: 4
  min_interval_ms: 0
licence: CC-BY-4.0
commercial_use: true
attribution: "ISRIC — World Soil Information"
attribution_url: https://soilgrids.org
overlay:
  kind: raster
  tiles:
    - "https://maps.isric.org/mapserv?map=/map/phh2o.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=phh2o_0-5cm_mean&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}"
  tile_size: 256
  min_zoom: 2
  max_zoom: 14
  opacity: 0.65
  legend:
    title: pH in water
    items:
      - { label: "3.5 — strongly acidic", color: "#f4f51e" }
      - { label: "7.0 — neutral", color: "#25a83d" }
      - { label: "9.2 — strongly alkaline", color: "#16c5d4" }
health_assertion:
  at: [16.37, 48.21]
  expect_range: [5.0, 9.0]     # post-scaling units, same as the pipeline output
coverage: global
provenance_note: "250 m modelled, not measured"
```
> *Schema note (v0.6):* the implemented descriptor schema v1 (`packages/core`) additionally defines optional `nodata` (sentinel filtered before scaling), `browser_access` (plan §5), `location_precision` (decision D5), `search_beyond_tile` (R4.4), and `params` (adapter-specific configuration). `value_type` is mandatory: it decides whether R6.3 (numeric) or R4.3 (categorical) binds. A layer declaring `overlay` mode also declares a validated rendering contract independent of its analytical adapter. An overlay-only layer uses `health_assertion.expect_overlay: true`; the canary validates a rendered tile rather than inventing a point value. A YAML file may contain one descriptor or a strict `defaults` + `layers` pack; `rate_limit.group` shares politeness and circuit state across layers using one provider. Every `bbox_vector` layer declares `params.protocol: overpass | sparql`; the selected strict query-template field contains one `{{spatial}}` placeholder, and SPARQL templates are constrained WHERE-body fragments rather than arbitrary queries.
### 6.1 Requirements
- R6.1 No layer-specific logic outside its adapter. If a layer needs bespoke code, the adapter is under-specified.
- R6.2 `licence`, `commercial_use`, `attribution` are mandatory fields, validated at load. A layer without them fails to register.
- R6.3 `unit` and `scale_factor` are mandatory for numeric layers. Silent scaling errors are among the most common and hardest-to-notice defects.
- R6.4 `provenance_note` distinguishes measured from modelled data, and is surfaced to the user.
---
## 7. Caching, rate limiting, politeness
A viewport query fanning out across 30 layers is 30 concurrent requests, several of them against volunteer-run infrastructure.
- R7.1 **Lazy fetch.** A layer is queried only when its panel is expanded or its overlay is enabled — never on every pan.
- R7.2 **Tile-keyed cache** with per-layer TTL from the descriptor.
- R7.3 **Per-layer or shared-provider concurrency cap and minimum interval**, enforced centrally from the descriptor. Layers using one upstream share `rate_limit.group`.
- R7.4 **Debounce map movement** before dispatching any query.
- R7.5 Correct `User-Agent` with contact details on every request (mandatory for MET Norway; strongly expected by Nominatim, Overpass, and most volunteer services).
- R7.6 Respect `429` and `Retry-After` with exponential backoff; circuit-break a layer that repeatedly fails rather than retrying into a ban.
**Specific hazards:** Overpass will rate-limit and then ban. Nominatim likewise. MET Norway requires identifying headers. These are not theoretical.
---
## 8. Resilience — the real failure mode
Licence drift is a slow, visible risk. **Silent schema change is the fast, invisible one**: a field renamed, a CRS quietly switched from EPSG:31287 to EPSG:4326, a WMS layer name versioned, a scale factor changed.
- R8.1 Every layer carries a `health_assertion`: a known coordinate with a known expected answer/range, or a rendered-tile canary for an overlay-only source.
- R8.2 Health checks run on a schedule (independent of user activity) and report per-layer status.
- R8.3 A failed assertion marks the layer degraded in the UI rather than removing it silently.
- R8.4 Adapters must never guess CRS. Missing or ambiguous CRS is a hard error.
- R8.5 Layer status history is retained, so "when did this break" is answerable.
---
## 9. Derived and precomputed layers
For anything computed locally rather than fetched:
- R9.1 Output to **PMTiles** — single file, HTTP range-readable, no tile server required.
- R9.2 Record the derivation inputs and date in `provenance_note`.
Candidate derivations, in rough order of value:
1. **Viewshed and sun/shadow at a given date and time**, from national LiDAR DTM/DSM. Fully local once the DTM is downloaded, no API, no ongoing dependency. Now the strongest candidate: it is the only high-value derivation with no upstream feed to build or maintain.
2. **Crop-type maps** from IACS/INVEKOS parcel data joined to declared crop.
3. **Broadcast/transmitter coverage prediction**, from regulator transmitter data plus terrain. No consumer app offers this.
4. **Historical-vs-present slider compare**, from historical aerial and map series.
5. **ADS-B analytics** — runway in use at nearby airports; holding-pattern detection; go-arounds; contrail-likely aircraft (cross-referencing temperature/humidity at flight level from a weather model); medical helicopter activity; transponder gaps; altitude-vs-time profiles. High value, but **conditional on first building and operating an aircraft feed** (see §10.1 and §12.8), which is standing infrastructure rather than code. Sequence after the A5 adapter is proven.
---
## 10. Layer catalogue
Adapter codes: **A1** bbox vector · **A2** COG raster · **A3** region lookup · **A4** point sample · **A5** stream · **A6** precomputed.
> **All entries require verification before implementation.** Endpoint availability, terms, and licence status drift constantly, especially for volunteer-run and crowdsourced sources. Assessments below reflect knowledge current to roughly mid-2026 and are not a substitute for checking.
### 10.1 Motion and transport
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Aircraft (ADS-B) | OpenSky Network (free tier, rate-limited); community feeds — adsb.lol, adsb.fi, airplanes.live; or own receiver (RTL-SDR + dump1090) | A5 | global / as ingested | **source not yet decided — see §12.8.** ADSBexchange terms changed after acquisition; verify before relying on it. Own receiver gives full control and no terms, but line-of-sight coverage only |
| Ships (AIS) | aisstream.io; Norwegian Coastal Administration; Digitraffic (FI) | A5 | regional | **no free global AIS exists**; MarineTraffic is paid |
| Trains (live GPS) | Digitraffic (FI, best free anywhere); opentransportdata.swiss; Entur (NO); NDOV (NL) | A5 | per-country | Germany patchy |
| PT departures | National Access Points (mandated in every EU state); Mobility Database for static GTFS | A5/A1 | EU-wide, patchwork | GTFS-RT or SIRI depending on state |
| Bike & scooter share | GBFS | A1 | global | **one spec, hundreds of cities — highest value per effort** |
| EV chargers | Open Charge Map | A1 | global | some NAPs add live availability |
| Traffic incidents & roadworks | DATEX II per-country | A1 | EU, patchwork | EU standard |
| Road cameras & road weather | Digitraffic; Trafikverket; RWS (NL); ASFINAG (AT) | A1 | regional | |
| APRS beacons | APRS-IS / aprs.fi | A5 | global | trivially streamable |
| Hiking & cycling routes | Waymarked Trails (OSM relations) | A6/A1 | global | ready-made tiles |
### 10.2 Sky and space
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Satellites | CelesTrak TLE + satellite.js, propagated client-side | A6 | global | no backend, no rate limit, visually strong |
| Airspace / airports / navaids | OpenAIP | A1 | global | static, cheap, and independently useful — worth building before any aircraft feed, not after |
| Lightning | Blitzortung | A5 | global | **non-commercial terms** |
| Aurora forecast | NOAA SWPC OVATION | A2 | global | |
| NRT satellite imagery | NASA GIBS (WMTS) | A6/overlay | global | just a tile URL; an afternoon of work |
| Webcams | Windy Webcams API | A1 | global | free tier |
### 10.3 Atmosphere, weather, hazard
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Weather point forecast | Open-Meteo (no key); MET Norway Locationforecast | A4 | global | MET Norway requires identifying User-Agent |
| Air quality | OpenAQ; EEA; Sensor.Community (~15k sensors) | A1 | global / EU | sparse-vs-dense aggregation problem, see §4 |
| Pollen | CAMS European forecast via Open-Meteo air quality API | A4 | EU | |
| Wildfire hotspots | NASA FIRMS (VIIRS/MODIS); EFFIS | A1 | global / EU | free key, ~3 h latency |
| Drought | European Drought Observatory | A3/A2 | EU | NUTS-level or raster |
| River levels & flood gauges | Pegelonline (DE); EA (UK); eHYD (AT); EFAS/GloFAS | A1 | per-country / EU | |
| Flood hazard zones | HORA (AT); EU Floods Directive maps per state | A1 | EU, patchwork | INSPIRE WFS |
| Avalanche bulletins | EAWS members (harmonised CAAML/GeoJSON) | A3 | Alps + Nordics | warning regions, not tiles |
| Strategic noise maps | EEA / Environmental Noise Directive | A2/A1 | EU agglomerations | modelled road/rail/air contours |
### 10.4 Subsurface and terrain
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Geology | OneGeology (global WMS); EGDI; national surveys (e.g. GBA WMS) | A2/A4 | global / EU | modal-vs-proportional aggregation matters |
| Soil | SoilGrids 250 m (ISRIC); LUCAS topsoil points | A2/A1 | global / EU | modelled, not measured |
| Radon potential | JRC European Atlas of Natural Radiation | A2 | EU | genuinely useful, almost unknown |
| Seismic hazard | ESHM20 | A2 | EU | expected peak ground acceleration |
| Terrain / LiDAR | Copernicus DEM GLO-30 (global); national sub-metre DTM/DSM: AT, NL (AHN), CH, FI, SI, DK | A2 | global / national | national data enables viewshed and sun/shadow locally |
| Ground motion (InSAR) | **European Ground Motion Service** | A2 | EU | mm-scale subsidence, free, essentially no consumer view exists — strong differentiator |
| Historical mining / abandoned works | national geological surveys | A1 | patchwork | mapped in AT |
| Cadastral parcels | INSPIRE services: BEV (AT), NL, ES, DK | A1 | EU, patchwork | zoom-limit hard, millions of polygons |
### 10.5 Environment and land
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Land cover 10 m | Copernicus WorldCover | A2 | global | |
| Land cover (EU classes) | CORINE | A2 | EU | |
| Crop-type parcels | IACS/INVEKOS (AT), DK, NL, SI, RPG (FR) | A1 | patchwork | **obscure gem** — every field polygon with declared crop, per year |
| CAP subsidy recipients | per-member-state publication (mandated) | A1/A3 | EU | joins to crop parcels above |
| Protected areas | Natura 2000 (EU); WDPA (global) | A1 | EU / global | |
| Bathing water quality | EEA | A1 | EU | multi-year classification per site |
| Light pollution | VIIRS; Falchi World Atlas; NASA Black Marble | A2 | global | |
| Radiation monitoring | EURDEP (official); Safecast (crowdsourced) | A1 | EU / global | |
| Species occurrences | GBIF | A1 | global | |
| Bird sightings (NRT) | eBird | A1 | global | free key; underrated and engaging |
| Animal tracking | Movebank public studies | A5/A1 | selected | storks, wolves, vultures with real GPS traces |
| City tree cadastres | Vienna, Berlin, Amsterdam, dozens more | A1 | per-city | species, planting year, trunk diameter |
### 10.6 Energy, utilities, infrastructure
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Live grid: generation mix, flows, prices | **ENTSO-E Transparency Platform**; Energy-Charts (friendlier wrapper) | A3 | EU | free key; one of the richest free European datasets in existence |
| Power plants | WRI Global Power Plant Database; Global Energy Monitor trackers | A1 | global | CC-BY |
| Power outages (live) | several European DSOs incl. Austrian | A3 | patchwork | service-territory keyed |
| Solar yield | JRC PVGIS | A4 | global (EU-best) | click a roof → modelled kWh/yr; no key |
| Submarine cables | TeleGeography (open on GitHub) | A1 | global | |
| Internet exchange points | PeeringDB API | A1 | global | |
| Broadband speeds | Ookla open data | A6 | global | published keyed by z16 quadkey — local join |
| Cell towers | OpenCellID | A1 | global | **Mozilla Location Service retired 2024** — older tutorials are dead |
| Broadcast transmitters | RTR (AT); BNetzA (DE); FMLIST aggregate | A1 | per-country | site, power, frequency → coverage prediction (§9) |
| Community mesh nodes | Freifunk JSON endpoints | A1 | DE/AT | live node status |
| Fuel prices | Tankerkönig (DE, **non-commercial**); E-Control (AT, restricted); official ES API (excellent); prix-carburants (FR); MISE (IT) | A1 | patchwork | **no European feed exists**; 5–8 independent integrations, several countries have nothing |
### 10.7 Built environment and services
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Building footprints + height + year | 3D BAG (NL, best in world); AT and others close; Microsoft / Google Open Buildings (global) | A1 | global / national | |
| Energy performance certificates | open in several countries | A3/A1 | patchwork | enables heating-demand colouring |
| Arbitrary POIs | **Overpass API** | A1 | global | AEDs, toilets, fountains, benches, lockers, bunkers, chimneys — *the single widest-breadth integration in the catalogue* |
| Pharmacy on-call duty | Apothekennotdienst (AT, DE) | A3 | AT/DE | genuinely useful live layer |
| Street-level imagery | Mapillary API | A1 | global | |
### 10.8 History and heritage
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Historical map overlays | Franziszeische Landesaufnahme (AT); NLS (UK) | overlay | national | slider-compare vs OSM is genuinely delightful |
| Historical aerial imagery | RAF/USAAF reconnaissance; national series (AT from late 1930s, UK, NL) | overlay | national | |
| Archaeological registers | Fundstellen (AT); Historic England; Archis (NL) | A1 | national | **precision deliberately fuzzed in some states to deter looting** — do not present as exact |
| Listed monuments | Bundesdenkmalamt (AT, open data); most European states | A1 | EU | |
| Ancient world gazetteers | Pleiades (~40k places); Digital Atlas of the Roman Empire; Itiner-e (Roman roads) | A1 | Mediterranean/EU | Roman roads over modern OSM is startlingly good |
| Stolpersteine | open dataset | A1 | EU-wide | |
| Shipwrecks | UKHO (open); other national hydrographic offices | A1 | regional | |
### 10.9 People, society, events
| Layer | Source | Adapter | Coverage | Notes |
|---|---|---|---|---|
| Population grids | Eurostat GISCO 1 km; GHSL; WorldPop; Kontur (H3) | A6/A2 | EU / global | local join, no query logic |
| Property transactions | UK Land Registry Price Paid; French DVF | A1 | UK/FR only | fully open, every transaction, geolocated. **DE and AT have essentially nothing** |
| Crime | police.uk | A1 | UK only | street-level, excellent. **Near-zero European equivalent — privacy law forecloses it** |
| Elections | national open data | A3 | patchwork | NUTS/LAU keyed |
| Eurostat indicators | Eurostat | A3 | EU | |
| Emergency dispatches | P2000 (NL, publicly decoded and geocoded, near real time); partial equivalents elsewhere | A5 | NL mainly | **ethically thorny** — decide policy before building |
| Conflict & news events | GDELT (geocoded global news, 15 min cadence); ACLED (**academic terms**) | A1 | global | |
| Encyclopaedic context | Wikipedia geosearch; **Wikidata SPARQL** | A1 | global | one query gets every lighthouse / castle / decommissioned reactor in Europe — enormous breadth, single integration |
---
## 11. Suggested phasing
**Phase 0 — foundations.** Layer descriptor schema and loader with mandatory-field validation. Central rate limiter and cache. Health-check runner. Empty-state model. Attribution rendering. Build against three deliberately different layers to force the abstraction honest: one A1 (Overpass), one A2 (SoilGrids), one A3 (ENTSO-E).
**Phase 1 — cheap breadth.** Everything that is one integration for many datasets: Overpass, Wikidata SPARQL, WFS/INSPIRE generic client, GBFS, GIBS tiles, Open-Meteo. This is where the app first stops being a demo and starts answering unanticipated questions.
**Phase 2 — differentiators.** EGMS ground motion, PVGIS, IACS crop parcels, LiDAR viewshed/shadow, transmitter coverage, historical imagery compare. The layers nobody has made pretty. All are request/response or fully local — no standing infrastructure.
**Phase 3 — streams.** Build the A5 adapter and its state store, then aircraft, AIS, APRS, EMSC, GTFS-RT. Derived ADS-B analytics (§9, derivation 5) follows here, not before.
**Phase 4 — long tail.** Per-country patchworks (fuel prices, property, crime), region-keyed services, crowdsourced feeds.
Rationale: an OGC/WFS generic client in Phase 1 unlocks dozens of layers at once, which is the leverage that makes breadth tractable rather than a linear grind. Streams are deferred to Phase 3 deliberately — they are the only adapter requiring a persistent process, reconnect logic, and state expiry, and letting that shape the architecture early would distort a design whose other five adapters are stateless and on-demand.
---
## 12. Open decisions
1. **Architecture split.** Server-side query proxy with shared tile cache, vs. pure client. A proxy is strongly indicated: it centralises rate limiting, keys, caching, CORS, and health checks. Cost is hosting and an extra hop.
2. **Storage.** Whether a local datastore is needed at all beyond the cache, and whether historical values are retained (turning the app from an observer into an archive — a significant scope change).
3. **Composition.** Whether cross-layer composition is a first-class feature (wind field + generation mix + prices; air quality + traffic + wind) or an emergent property of toggling overlays. First-class composition is the most defensible capability but adds real complexity.
4. **P2000 / emergency dispatch policy.** Decide before building, not after.
5. **Archaeological precision.** Whether to display fuzzed heritage locations at all, and how to signal fuzzing.
6. **Offline behaviour.** Does the app degrade gracefully in the field with no connectivity? Relevant given the "here, standing outdoors" use case; affects whether COG and PMTiles assets are pre-cached.
7. **Attribution surface.** Per-layer credit in panel, aggregate credits page, or both.
8. **Aircraft feed source.** OpenSky (free but rate-limited and historically flaky), a community aggregator (adsb.lol / adsb.fi / airplanes.live — generous, volunteer-run, so subject to the politeness rules in §7), or an own RTL-SDR receiver (no terms at all, full control, but line-of-sight coverage only and it becomes hardware you maintain). Feeding a community aggregator from an own receiver typically earns elevated API access — worth checking, as it resolves both sides at once.
9. **Prototype salvage.** Nothing from the flight-radar prototype is assumed to carry over, but its map/render layer and any working ADS-B decode are the two parts most likely worth lifting. Decide explicitly what is copied versus rewritten, rather than drifting into an accidental port.
---
## 13. Verification checklist per new layer
Before a layer is considered done:
- [ ] Endpoint reachable, terms read, licence and `commercial_use` recorded
- [ ] Attribution string and URL recorded and rendering
- [ ] Native CRS confirmed explicitly (not inferred)
- [ ] Unit and scale factor confirmed against a known-value coordinate
- [ ] Aggregation function declared and justified
- [ ] `zoom_valid` range determined empirically, not guessed
- [ ] Rate limit / politeness requirements read from provider docs
- [ ] `health_assertion` written with a coordinate and expected range, or `expect_overlay: true` for overlay-only data
- [ ] All three empty states verified to render distinguishably
- [ ] Coverage extent recorded, so "no coverage" is truthful
- [ ] Modelled-vs-measured noted in `provenance_note`
- [ ] `browser_access` declared; the real Pages origin passes CORS (and `Range` for COG) or the materialize/drop decision is recorded
- [ ] Live browser-access verification passes, not only a Node request
- [ ] The operational steps in `docs/adding-a-layer.md` pass
