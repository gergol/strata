/**
 * Reproducible vector-PMTiles derivation and provenance verification (M2.1).
 *
 * Source-specific preparation is deliberately separate: this command accepts a
 * pinned GeoJSON/FlatGeobuf input, verifies its digest, invokes Tippecanoe
 * without a shell, validates the PMTiles archive through the reference decoder,
 * and atomically publishes the archive plus a provenance sidecar.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles';
import { z } from 'zod';

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const REPO_PATH = /^(?!\/)(?!.*\/\/)[A-Za-z0-9.][A-Za-z0-9._/-]*$/;
const MIN_TIPPECANOE_VERSION = [2, 17, 0] as const;
const require = createRequire(import.meta.url);
const PMTILES_DECODER_VERSION = (require('pmtiles/package.json') as { version: string }).version;

const sourceSchema = z
  .object({
    url: z.string().url(),
    release: z.string().min(1),
    sha256: z.string().regex(SHA256),
    licence: z.string().min(1),
  })
  .strict();

const inputSchema = z
  .object({
    path: z.string().regex(REPO_PATH),
    format: z.enum(['geojson', 'flatgeobuf']),
    sha256: z.string().regex(SHA256),
  })
  .strict();

const publicationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pages') }).strict(),
  z.object({ kind: z.literal('release'), asset_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) }).strict(),
  z.object({ kind: z.literal('local') }).strict(),
]);

const outputSchema = z
  .object({
    path: z.string().regex(REPO_PATH),
    publication: publicationSchema,
  })
  .strict();

const tilesSchema = z
  .object({
    layer: z.string().regex(SAFE_ID),
    name: z.string().min(1),
    description: z.string().min(1),
    attribution: z.string().min(1),
    min_zoom: z.number().int().min(0).max(22),
    max_zoom: z.number().int().min(0).max(22),
    include_properties: z.array(z.string().min(1)).optional(),
    drop_densest_as_needed: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.min_zoom <= value.max_zoom, {
    message: 'min_zoom must not exceed max_zoom',
    path: ['min_zoom'],
  });

export const derivationRecipeSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(SAFE_ID),
    source: sourceSchema,
    input: inputSchema,
    transformations: z.array(z.string().min(1)).nonempty(),
    output: outputSchema,
    tiles: tilesSchema,
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const output = recipe.output.path.replaceAll('\\', '/');
    if ([...recipe.input.path.split('/'), ...output.split('/')].some((segment) => segment === '.' || segment === '..')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'path'],
        message: 'recipe paths must be canonical and cannot contain . or .. segments',
      });
    }
    const requiredPrefix = {
      pages: 'packages/client/public/data/derived/',
      release: 'data/derived/',
      local: '.cache/derive/',
    }[recipe.output.publication.kind];
    if (!output.startsWith(requiredPrefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'path'],
        message: `${recipe.output.publication.kind} outputs must be under ${requiredPrefix}`,
      });
    }
    if (!output.endsWith('.pmtiles')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'path'],
        message: 'output path must end in .pmtiles',
      });
    }
    if (
      recipe.output.publication.kind === 'release' &&
      recipe.output.publication.asset_name !== basename(output)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'publication', 'asset_name'],
        message: 'release asset_name must match the output basename',
      });
    }
  });

export type DerivationRecipe = z.infer<typeof derivationRecipeSchema>;

interface ArchiveSummary {
  spec_version: number;
  tile_type: 'mvt';
  min_zoom: number;
  max_zoom: number;
  bounds: [number, number, number, number];
  addressed_tiles: number;
  tile_entries: number;
  tile_contents: number;
  layer: string;
}

interface DerivationProvenance {
  schema_version: 1;
  id: string;
  generated_at: string;
  recipe: { path: string; sha256: string };
  source: DerivationRecipe['source'];
  input: DerivationRecipe['input'];
  transformations: [string, ...string[]];
  artifact: {
    path: string;
    sha256: string;
    bytes: number;
    archive: ArchiveSummary;
  };
  toolchain: { node: string; tippecanoe: string; pmtiles_decoder: string };
  publication: DerivationRecipe['output']['publication'];
}

const archiveSummarySchema = z
  .object({
    spec_version: z.literal(3),
    tile_type: z.literal('mvt'),
    min_zoom: z.number().int().min(0).max(22),
    max_zoom: z.number().int().min(0).max(22),
    bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    addressed_tiles: z.number().int().positive(),
    tile_entries: z.number().int().positive(),
    tile_contents: z.number().int().positive(),
    layer: z.string().regex(SAFE_ID),
  })
  .strict();

const provenanceSchema: z.ZodType<DerivationProvenance> = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(SAFE_ID),
    generated_at: z.string().datetime(),
    recipe: z.object({ path: z.string().min(1), sha256: z.string().regex(SHA256) }).strict(),
    source: sourceSchema,
    input: inputSchema,
    transformations: z.array(z.string().min(1)).nonempty(),
    artifact: z
      .object({
        path: z.string().min(1),
        sha256: z.string().regex(SHA256),
        bytes: z.number().int().positive(),
        archive: archiveSummarySchema,
      })
      .strict(),
    toolchain: z
      .object({
        node: z.string().regex(/^v\d+\.\d+\.\d+/),
        tippecanoe: z.string().regex(/^\d+\.\d+\.\d+$/),
        pmtiles_decoder: z.string().regex(/^pmtiles@\d+\.\d+\.\d+$/),
      })
      .strict(),
    publication: publicationSchema,
  })
  .strict();

class NodeFileSource implements Source {
  constructor(private readonly path: string) {}

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) as ArrayBuffer;
      return { data };
    } finally {
      await handle.close();
    }
  }
}

function repoPath(path: string): string {
  if (isAbsolute(path)) throw new Error(`repository path must be relative: ${path}`);
  const root = resolve(process.cwd());
  const absolute = resolve(root, path);
  const within = relative(root, absolute);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error(`path escapes repository: ${path}`);
  return absolute;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function loadDerivationRecipe(path: string): DerivationRecipe {
  const raw: unknown = JSON.parse(readFileSync(repoPath(path), 'utf8'));
  return derivationRecipeSchema.parse(raw);
}

export function parseTippecanoeVersion(output: string): [number, number, number] {
  const match = /tippecanoe v(\d+)\.(\d+)\.(\d+)/i.exec(output);
  if (!match) throw new Error(`could not parse Tippecanoe version from: ${output.trim()}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: readonly number[], required: readonly number[]): boolean {
  for (let i = 0; i < required.length; i += 1) {
    const difference = (actual[i] ?? 0) - (required[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function buildTippecanoeArgs(recipe: DerivationRecipe, outputPath: string): string[] {
  repoPath(recipe.input.path);
  const args = [
    '--output',
    outputPath,
    '--projection=EPSG:4326',
    '--minimum-zoom',
    String(recipe.tiles.min_zoom),
    '--maximum-zoom',
    String(recipe.tiles.max_zoom),
    '--layer',
    recipe.tiles.layer,
    '--name',
    recipe.tiles.name,
    '--description',
    recipe.tiles.description,
    '--attribution',
    recipe.tiles.attribution,
  ];
  if (recipe.tiles.drop_densest_as_needed) args.push('--drop-densest-as-needed');
  for (const property of recipe.tiles.include_properties ?? []) args.push('--include', property);
  args.push(recipe.input.path);
  return args;
}

function tippecanoeVersion(executable: string): string {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Tippecanoe version check failed with exit code ${result.status}: ${result.stderr.trim()}`);
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const version = parseTippecanoeVersion(output);
  if (!versionAtLeast(version, MIN_TIPPECANOE_VERSION)) {
    throw new Error(
      `Tippecanoe ${version.join('.')} cannot emit PMTiles; ${MIN_TIPPECANOE_VERSION.join('.')} or newer is required`,
    );
  }
  return version.join('.');
}

async function inspectArchive(path: string, expectedLayer: string): Promise<ArchiveSummary> {
  const archive = new PMTiles(new NodeFileSource(path));
  const header = await archive.getHeader();
  const metadata = await archive.getMetadata();
  if (header.specVersion !== 3) throw new Error(`unsupported PMTiles specification ${header.specVersion}`);
  if (header.tileType !== TileType.Mvt) throw new Error(`expected MVT tile type, got ${header.tileType}`);
  if (header.numAddressedTiles < 1 || header.numTileEntries < 1 || header.numTileContents < 1) {
    throw new Error('PMTiles archive contains no addressable tiles');
  }
  const vectorLayers =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as { vector_layers?: unknown }).vector_layers
      : undefined;
  if (
    !Array.isArray(vectorLayers) ||
    !vectorLayers.some(
      (layer) => typeof layer === 'object' && layer !== null && (layer as { id?: unknown }).id === expectedLayer,
    )
  ) {
    throw new Error(`PMTiles metadata does not contain vector layer '${expectedLayer}'`);
  }
  return {
    spec_version: header.specVersion,
    tile_type: 'mvt',
    min_zoom: header.minZoom,
    max_zoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    addressed_tiles: header.numAddressedTiles,
    tile_entries: header.numTileEntries,
    tile_contents: header.numTileContents,
    layer: expectedLayer,
  };
}

function generatedAt(): string {
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  if (epoch === undefined) return new Date().toISOString();
  if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be an integer number of Unix seconds');
  return new Date(Number(epoch) * 1000).toISOString();
}

function provenancePath(recipe: DerivationRecipe): string {
  return `${recipe.output.path}.provenance.json`;
}

export async function buildDerivation(recipeFile: string): Promise<DerivationProvenance> {
  const recipe = loadDerivationRecipe(recipeFile);
  const inputPath = repoPath(recipe.input.path);
  const inputHash = sha256File(inputPath);
  if (inputHash !== recipe.input.sha256) {
    throw new Error(`input digest mismatch: expected ${recipe.input.sha256}, got ${inputHash}`);
  }
  if (recipe.source.sha256 !== inputHash && recipe.transformations.length === 1 && recipe.transformations[0] === 'none') {
    throw new Error('an untransformed input must have the same digest as its source');
  }

  const executable = process.env['TIPPECANOE'] ?? 'tippecanoe';
  const version = tippecanoeVersion(executable);
  const outputPath = repoPath(recipe.output.path);
  mkdirSync(dirname(outputPath), { recursive: true });
  // Tippecanoe records argv in archive metadata. Stable repository-relative
  // paths are therefore part of the bit-for-bit reproducibility contract.
  const temporaryRelative = `${recipe.output.path}.build.pmtiles`;
  const temporary = repoPath(temporaryRelative);
  rmSync(temporary, { force: true });
  try {
    const build = spawnSync(executable, buildTippecanoeArgs(recipe, temporaryRelative), {
      argv0: 'tippecanoe',
      stdio: 'inherit',
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Tippecanoe build failed with exit code ${build.status}`);
    const archive = await inspectArchive(temporary, recipe.tiles.layer);
    if (archive.min_zoom !== recipe.tiles.min_zoom || archive.max_zoom !== recipe.tiles.max_zoom) {
      throw new Error(
        `archive zooms ${archive.min_zoom}-${archive.max_zoom} do not match recipe ${recipe.tiles.min_zoom}-${recipe.tiles.max_zoom}`,
      );
    }
    renameSync(temporary, outputPath);

    const provenance: DerivationProvenance = {
      schema_version: 1,
      id: recipe.id,
      generated_at: generatedAt(),
      recipe: { path: recipeFile, sha256: sha256File(repoPath(recipeFile)) },
      source: recipe.source,
      input: recipe.input,
      transformations: recipe.transformations,
      artifact: {
        path: recipe.output.path,
        sha256: sha256File(outputPath),
        bytes: statSync(outputPath).size,
        archive,
      },
      toolchain: { node: process.version, tippecanoe: version, pmtiles_decoder: `pmtiles@${PMTILES_DECODER_VERSION}` },
      publication: recipe.output.publication,
    };
    const sidecar = repoPath(provenancePath(recipe));
    const sidecarTemporary = `${sidecar}.${process.pid}.tmp`;
    writeFileSync(sidecarTemporary, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
    renameSync(sidecarTemporary, sidecar);
    return provenance;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function verifyDerivation(recipeFile: string): Promise<DerivationProvenance> {
  const recipe = loadDerivationRecipe(recipeFile);
  const outputPath = repoPath(recipe.output.path);
  const sidecarPath = repoPath(provenancePath(recipe));
  const provenance = provenanceSchema.parse(JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown);
  if (provenance.id !== recipe.id) throw new Error('provenance identity mismatch');
  if (provenance.recipe.sha256 !== sha256File(repoPath(recipeFile))) throw new Error('recipe digest mismatch');
  if (provenance.recipe.path !== recipeFile) throw new Error('provenance recipe path mismatch');
  if (JSON.stringify(provenance.source) !== JSON.stringify(recipe.source)) throw new Error('provenance source mismatch');
  if (JSON.stringify(provenance.input) !== JSON.stringify(recipe.input)) throw new Error('provenance input mismatch');
  if (JSON.stringify(provenance.transformations) !== JSON.stringify(recipe.transformations)) {
    throw new Error('provenance transformations mismatch');
  }
  if (JSON.stringify(provenance.publication) !== JSON.stringify(recipe.output.publication)) {
    throw new Error('provenance publication mismatch');
  }
  if (provenance.artifact.path !== recipe.output.path) throw new Error('provenance artifact path mismatch');
  if (provenance.input.sha256 !== sha256File(repoPath(recipe.input.path))) throw new Error('input digest mismatch');
  if (provenance.artifact.sha256 !== sha256File(outputPath)) throw new Error('artifact digest mismatch');
  if (provenance.artifact.bytes !== statSync(outputPath).size) throw new Error('artifact size mismatch');
  const archive = await inspectArchive(outputPath, recipe.tiles.layer);
  if (JSON.stringify(archive) !== JSON.stringify(provenance.artifact.archive)) {
    throw new Error('archive metadata does not match stamped provenance');
  }
  return provenance;
}

export async function reproduceDerivation(recipeFile: string): Promise<DerivationProvenance> {
  const first = await buildDerivation(recipeFile);
  const second = await buildDerivation(recipeFile);
  if (first.artifact.sha256 !== second.artifact.sha256) {
    throw new Error(
      `derivation is not reproducible: consecutive builds produced ${first.artifact.sha256} and ${second.artifact.sha256}`,
    );
  }
  await verifyDerivation(recipeFile);
  return second;
}

function paths(recipeFile: string): Record<string, unknown> {
  const recipe = loadDerivationRecipe(recipeFile);
  return {
    id: recipe.id,
    artifact: recipe.output.path,
    provenance: provenancePath(recipe),
    publication: recipe.output.publication,
  };
}

async function main(args: string[]): Promise<number> {
  const [command, recipeFile] = args;
  if (!command || !recipeFile || !['build', 'verify', 'reproduce', 'paths'].includes(command)) {
    console.error('usage: derive-pmtiles.ts <build|verify|reproduce|paths> <recipe.json>');
    return 2;
  }
  if (command === 'paths') {
    console.log(JSON.stringify(paths(recipeFile)));
    return 0;
  }
  const provenance =
    command === 'build'
      ? await buildDerivation(recipeFile)
      : command === 'reproduce'
        ? await reproduceDerivation(recipeFile)
        : await verifyDerivation(recipeFile);
  console.log(
    `${command === 'build' ? 'built' : command === 'reproduce' ? 'reproduced' : 'verified'} ${provenance.artifact.path} ` +
      `(${provenance.artifact.bytes} bytes, sha256 ${provenance.artifact.sha256})`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
