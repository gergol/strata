/**
 * The layer descriptor schema — the configuration contract of requirements §6.
 * Validation here is the enforcement point for R6.2 (licence/attribution mandatory),
 * R6.3 (unit/scale_factor mandatory for numeric layers), R8.4 (no CRS guessing),
 * R4.1/R4.3 (declared aggregation), R5.1 (zoom validity) and D5 (heritage precision).
 *
 * The schema is `.strict()` throughout: an unrecognised or misspelled key is an
 * error, because a typo'd `scale_faktor` silently defaulting away is exactly the
 * failure class this file exists to prevent.
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { isKnownCrs, knownCrsCodes } from './crs.js';
import { isValidDuration } from './units.js';

export const ADAPTERS = ['bbox_vector', 'cog', 'region', 'point_sample', 'stream', 'precomputed'] as const;
export type AdapterId = (typeof ADAPTERS)[number];

export const MODES = ['point', 'tile', 'overlay'] as const;
export type Mode = (typeof MODES)[number];

export const DOMAINS = [
  'transport',
  'sky',
  'weather',
  'subsurface',
  'terrain',
  'environment',
  'energy',
  'built',
  'history',
  'society',
] as const;
export type Domain = (typeof DOMAINS)[number];

export const AGGREGATIONS = [
  'mean',
  'min',
  'max',
  'median',
  'p10',
  'p90',
  'sum',
  'count',
  'density',
  'histogram',
  'modal_with_confidence',
  'feature_list',
  'nearest',
  'latest',
] as const;
export type AggregationId = (typeof AGGREGATIONS)[number];

export const VALUE_TYPES = ['numeric', 'categorical', 'feature'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

const lonLatSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const healthAssertionSchema = z
  .object({
    at: lonLatSchema,
    expect_range: z.tuple([z.number(), z.number()]).optional(),
    expect_min_count: z.number().int().nonnegative().optional(),
    expect_status: z.enum(['ok', 'empty']).optional(),
    /** Overlay-only canary: the runner probes an expanded rendered tile URL. */
    expect_overlay: z.literal(true).optional(),
  })
  .strict()
  .superRefine((h, ctx) => {
    if (
      h.expect_range === undefined &&
      h.expect_min_count === undefined &&
      h.expect_status === undefined &&
      h.expect_overlay === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'health_assertion must declare at least one expectation (expect_range, expect_min_count, expect_status, or expect_overlay) — R8.1',
      });
    }
    if (h.expect_range !== undefined && h.expect_range[0] > h.expect_range[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expect_range'],
        message: `expect_range must be [low, high], got [${h.expect_range[0]}, ${h.expect_range[1]}]`,
      });
    }
  });

const rateLimitSchema = z
  .object({
    /** Layers sharing an upstream use one limiter/circuit state (for example an Overpass instance). */
    group: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
    max_concurrent: z.number().int().min(1).default(2),
    min_interval_ms: z.number().int().min(0).default(0),
  })
  .strict();

const coverageSchema = z.union([
  z.literal('global'),
  z.object({ bbox: bboxSchema }).strict(),
  z.object({ regions: z.array(z.string().min(1)).nonempty() }).strict(),
]);

const aggregationDeclSchema = z
  .object({
    primary: z.enum(AGGREGATIONS),
    secondary: z.array(z.enum(AGGREGATIONS)).optional(),
  })
  .strict();

const overlayLegendItemSchema = z
  .object({
    label: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a six-digit hex value'),
  })
  .strict();

const rasterOverlayTimeSchema = z
  .object({
    kind: z.literal('daily_utc'),
    default_offset_days: z.number().int().min(-30).max(0).default(-1),
    max_age_days: z.number().int().min(1).max(366).default(30),
  })
  .strict();

const rasterOverlaySchema = z
  .object({
    kind: z.literal('raster'),
    tiles: z.array(z.string().url()).nonempty(),
    tile_size: z.number().int().min(128).max(512).default(256),
    min_zoom: z.number().int().min(0).max(22),
    max_zoom: z.number().int().min(0).max(22),
    opacity: z.number().min(0).max(1).default(0.65),
    time: rasterOverlayTimeSchema.optional(),
    legend: z
      .object({
        title: z.string().min(1),
        items: z.array(overlayLegendItemSchema).nonempty(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((overlay, ctx) => {
    if (overlay.min_zoom > overlay.max_zoom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min_zoom'],
        message: `overlay min_zoom must not exceed max_zoom (${overlay.min_zoom} > ${overlay.max_zoom})`,
      });
    }
    const dateTemplates = overlay.tiles.filter((tile) => tile.includes('{date}'));
    if (overlay.time && dateTemplates.length !== overlay.tiles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiles'],
        message: 'every tile URL for a daily overlay must contain the {date} placeholder',
      });
    }
    if (!overlay.time && dateTemplates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['time'],
        message: 'tile URLs using {date} must declare an overlay time contract',
      });
    }
  });

const featureStyleSchema = z
  .object({
    kind: z.literal('circle'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    radius: z.number().min(2).max(16).default(6),
    opacity: z.number().min(0).max(1).default(0.9),
    stroke_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
    stroke_width: z.number().min(0).max(5).default(1.5),
  })
  .strict();

export const layerDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, 'id must be lowercase snake_case'),
    name: z.string().min(1),
    domain: z.enum(DOMAINS),
    adapter: z.enum(ADAPTERS),
    endpoint: z.string().url(),
    crs: z.string().regex(/^EPSG:\d+$/, 'crs must be an "EPSG:<code>" string'),
    modes: z.array(z.enum(MODES)).nonempty(),
    zoom_valid: z.tuple([z.number().int().min(0).max(22), z.number().int().min(0).max(22)]),
    value_type: z.enum(VALUE_TYPES),
    aggregation: aggregationDeclSchema.optional(),
    /** Post-scaling display unit — what every result carries (plan §5 amendment to §6). */
    unit: z.string().optional(),
    /** Upstream's raw unit before scale_factor, for documentation (e.g. "pH*10"). */
    native_unit: z.string().optional(),
    scale_factor: z.number().optional(),
    nodata: z.number().optional(),
    ttl: z.string().refine(isValidDuration, {
      message: 'ttl must be a duration like "30d", "12h", "5m", "90s", "500ms"',
    }),
    rate_limit: rateLimitSchema.default({ max_concurrent: 2, min_interval_ms: 0 }),
    licence: z.string().min(1),
    commercial_use: z.boolean(),
    attribution: z.string().min(1),
    attribution_url: z.string().url().optional(),
    health_assertion: healthAssertionSchema,
    coverage: coverageSchema,
    provenance_note: z.string().min(1),
    /** How the browser reaches this layer (plan §5): direct CORS, via materialized asset, or not at all. */
    browser_access: z.enum(['direct', 'materialized', 'blocked']).default('direct'),
    /** D5: mandatory for heritage-domain layers; fuzzed locations render as areas, never pins. */
    location_precision: z.enum(['exact', 'fuzzed', 'centroid']).optional(),
    /** R4.4: whether a sparse point layer may search beyond the queried geometry. */
    search_beyond_tile: z.boolean().default(false),
    /** M3 rendering contract. Kept independent of the analytical adapter. */
    overlay: rasterOverlaySchema.optional(),
    /** Descriptor-driven styling for vector features returned by point queries. */
    feature_style: featureStyleSchema.optional(),
    /** Adapter-specific configuration (e.g. an Overpass QL template). Validated by the adapter. */
    params: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (!isKnownCrs(d.crs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['crs'],
        message:
          `unknown CRS '${d.crs}'. Adapters must never guess CRS (R8.4); ` +
          `add a pinned proj4 definition to CRS_REGISTRY deliberately. Known: ${knownCrsCodes().join(', ')}`,
      });
    }
    if (d.zoom_valid[0] > d.zoom_valid[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zoom_valid'],
        message: `zoom_valid must be [min, max], got [${d.zoom_valid[0]}, ${d.zoom_valid[1]}]`,
      });
    }
    if (d.value_type === 'numeric') {
      if (d.unit === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unit'],
          message: 'unit is mandatory for numeric layers (R6.3)',
        });
      }
      if (d.scale_factor === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scale_factor'],
          message: 'scale_factor is mandatory for numeric layers (R6.3); use 1 explicitly if values are unscaled',
        });
      }
    }
    if (d.modes.includes('tile')) {
      if (d.aggregation === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aggregation'],
          message: 'layers supporting tile mode must declare exactly one primary aggregation (R4.1)',
        });
      } else if (
        d.value_type === 'categorical' &&
        d.aggregation.primary !== 'histogram' &&
        d.aggregation.primary !== 'modal_with_confidence'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aggregation', 'primary'],
          message:
            'categorical layers aggregate to a class histogram unless explicitly declared modal_with_confidence (R4.3)',
        });
      }
    }
    if (d.domain === 'history' && d.location_precision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['location_precision'],
        message: 'heritage-domain layers must declare location_precision (decision D5)',
      });
    }
    if (d.modes.includes('overlay') && d.overlay === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overlay'],
        message: 'layers supporting overlay mode must declare an overlay rendering contract',
      });
    }
    if (!d.modes.includes('overlay') && d.overlay !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modes'],
        message: 'a declared overlay rendering contract requires overlay mode',
      });
    }
    if (d.feature_style && (d.value_type !== 'feature' || !d.modes.includes('point'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feature_style'],
        message: 'feature_style requires a feature-valued point-query layer',
      });
    }
    const hasQueryMode = d.modes.includes('point') || d.modes.includes('tile');
    if (!hasQueryMode && d.modes.includes('overlay') && d.health_assertion.expect_overlay !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['health_assertion', 'expect_overlay'],
        message: 'overlay-only layers must declare expect_overlay: true so health probes the rendered tile',
      });
    }
    if (d.health_assertion.expect_overlay === true && !d.modes.includes('overlay')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['health_assertion', 'expect_overlay'],
        message: 'expect_overlay requires overlay mode',
      });
    }
    if (d.adapter === 'bbox_vector') {
      const protocol = d.params?.['protocol'];
      if (protocol !== 'overpass' && protocol !== 'sparql' && protocol !== 'wfs' && protocol !== 'gbfs') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'protocol'],
          message: "bbox_vector layers must declare params.protocol as 'overpass', 'sparql', 'wfs', or 'gbfs'",
        });
      }
      if (protocol === 'wfs') {
        const typeName = d.params?.['wfs_type_name'];
        if (typeof typeName !== 'string' || !/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(typeName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', 'wfs_type_name'],
            message: 'wfs_type_name must be a feature type name or namespace-qualified name',
          });
        }
        if (d.params?.['wfs_version'] !== '1.1.0' && d.params?.['wfs_version'] !== '2.0.0') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', 'wfs_version'],
            message: "wfs_version must be pinned as '1.1.0' or '2.0.0'",
          });
        }
        if (typeof d.params?.['wfs_srs_name'] !== 'string' || d.params['wfs_srs_name'].length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', 'wfs_srs_name'],
            message: 'wfs_srs_name must pin the exact advertised request CRS name',
          });
        }
        if (d.params?.['wfs_axis_order'] !== 'xy' && d.params?.['wfs_axis_order'] !== 'yx') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', 'wfs_axis_order'],
            message: "wfs_axis_order must be pinned as 'xy' or 'yx'",
          });
        }
        const labelFields = d.params?.['wfs_label_fields'];
        if (labelFields !== undefined && (
          !Array.isArray(labelFields) ||
          labelFields.length === 0 ||
          !labelFields.every((field) => typeof field === 'string' && field.length > 0)
        )) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', 'wfs_label_fields'],
            message: 'wfs_label_fields must be a non-empty array of field names',
          });
        }
        return;
      }
      if (protocol === 'gbfs') {
        if (d.value_type !== 'feature') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value_type'],
            message: 'GBFS layers return station features',
          });
        }
        const radius = d.params?.['point_radius_m'];
        if (radius !== undefined && (
          typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > 20_000
        )) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', 'point_radius_m'],
            message: 'GBFS point_radius_m must be in (0, 20000]',
          });
        }
        return;
      }
      const key = protocol === 'sparql' ? 'sparql_query' : 'overpass_query';
      const template = d.params?.[key];
      if (typeof template !== 'string' || !template.includes('{{spatial}}')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', key],
          message: `${key} must contain a {{spatial}} placeholder`,
        });
      } else if (protocol === 'sparql') {
        const placeholders = template.match(/\{\{[^}]+\}\}/g) ?? [];
        if (placeholders.length !== 1 || placeholders[0] !== '{{spatial}}') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', key],
            message: 'sparql_query may contain only the {{spatial}} placeholder',
          });
        }
        if (!template.includes('?item')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', key],
            message: 'sparql_query must constrain the injected ?item variable',
          });
        }
        if (/\b(?:SELECT|ASK|CONSTRUCT|DESCRIBE|SERVICE|LOAD|INSERT|DELETE|CLEAR|CREATE|DROP|MOVE|COPY|ADD)\b/i.test(template)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', key],
            message: 'sparql_query is a WHERE-body fragment; nested queries, services, and update operations are not allowed',
          });
        }
      }
    }
    if (d.adapter === 'point_sample') {
      if (d.value_type !== 'numeric') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value_type'],
          message: 'point_sample currently supports numeric response fields',
        });
      }
      if (typeof d.params?.['value_path'] !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(d.params['value_path'])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'value_path'],
          message: 'point_sample layers must declare a dotted JSON value_path',
        });
      }
      const sampleGrid = d.params?.['sample_grid'];
      if (sampleGrid !== undefined && (
        typeof sampleGrid !== 'number' ||
        !Number.isInteger(sampleGrid) ||
        sampleGrid < 1 ||
        sampleGrid > 5 ||
        sampleGrid % 2 === 0
      )) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'sample_grid'],
          message: 'sample_grid must be an odd integer from 1 to 5',
        });
      }
    }
    if (d.adapter === 'precomputed' && hasQueryMode) {
      if (d.value_type !== 'numeric') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value_type'],
          message: 'queryable precomputed indexes currently support numeric values',
        });
      }
      if (d.params?.['key_scheme'] !== 'quadkey_z16' && d.params?.['key_scheme'] !== 'epsg3035_grid_1km') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'key_scheme'],
          message: "queryable precomputed layers require key_scheme 'quadkey_z16' or 'epsg3035_grid_1km'",
        });
      }
      if (typeof d.params?.['value_field'] !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(d.params['value_field'])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'value_field'],
          message: 'queryable precomputed layers require a numeric value_field',
        });
      }
    }
  });

export type LayerDescriptor = z.infer<typeof layerDescriptorSchema>;
export type RasterOverlaySpec = z.infer<typeof rasterOverlaySchema>;

export class DescriptorValidationError extends Error {
  readonly issues: string[];
  constructor(layerId: string | undefined, issues: string[]) {
    super(
      `layer descriptor ${layerId ? `'${layerId}' ` : ''}failed validation and will not register (R6.2):\n` +
        issues.map((i) => `  - ${i}`).join('\n'),
    );
    this.name = 'DescriptorValidationError';
    this.issues = issues;
  }
}

/** Validates an already-parsed object. Throws DescriptorValidationError with precise issues. */
export function parseDescriptor(input: unknown): LayerDescriptor {
  const result = layerDescriptorSchema.safeParse(input);
  if (!result.success) {
    const id =
      typeof input === 'object' && input !== null && typeof (input as { id?: unknown }).id === 'string'
        ? ((input as { id: string }).id)
        : undefined;
    const issues = result.error.issues.map((iss) =>
      iss.path.length > 0 ? `${iss.path.join('.')}: ${iss.message}` : iss.message,
    );
    throw new DescriptorValidationError(id, issues);
  }
  return result.data;
}

const descriptorPackSchema = z
  .object({
    defaults: z.record(z.unknown()),
    layers: z.array(z.record(z.unknown())).nonempty(),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergePackLayer(defaults: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...defaults, ...layer };
  for (const [key, value] of Object.entries(layer)) {
    const defaultValue = defaults[key];
    if (isRecord(defaultValue) && isRecord(value)) merged[key] = { ...defaultValue, ...value };
  }
  return merged;
}

/** Parses a YAML layer file containing either one descriptor or defaults plus a descriptor pack. */
export function loadDescriptorsYaml(yamlText: string): LayerDescriptor[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    throw new DescriptorValidationError(undefined, [`not valid YAML: ${(e as Error).message}`]);
  }
  const isPack =
    typeof parsed === 'object' &&
    parsed !== null &&
    ('defaults' in parsed || 'layers' in parsed);
  if (!isPack) return [parseDescriptor(parsed)];

  const pack = descriptorPackSchema.safeParse(parsed);
  if (!pack.success) {
    throw new DescriptorValidationError(
      undefined,
      pack.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      ),
    );
  }
  const descriptors = pack.data.layers.map((layer) => parseDescriptor(mergePackLayer(pack.data.defaults, layer)));
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      throw new DescriptorValidationError(descriptor.id, ['duplicate id in descriptor pack']);
    }
    seen.add(descriptor.id);
  }
  return descriptors;
}

/** Parses a YAML file that must contain exactly one descriptor. */
export function loadDescriptorYaml(yamlText: string): LayerDescriptor {
  const descriptors = loadDescriptorsYaml(yamlText);
  if (descriptors.length !== 1) {
    throw new DescriptorValidationError(undefined, [
      `expected one descriptor, but the file contains a pack of ${descriptors.length}`,
    ]);
  }
  return descriptors[0] as LayerDescriptor;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Stable content hash of a descriptor (FNV-1a 32-bit over canonical JSON).
 * Part of every cache key, so editing a descriptor invalidates its cache — a
 * scale-factor fix must never serve stale mis-scaled values. Not cryptographic.
 */
export function descriptorHash(d: LayerDescriptor): string {
  const s = canonicalJson(d);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
