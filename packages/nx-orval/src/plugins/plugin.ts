import {
  type CreateDependencies,
  type CreateNodes,
  type CreateNodesContext,
  type CreateNodesResult,
  type RawProjectGraphDependency,
  type TargetConfiguration,
  DependencyType,
  createNodesFromFiles,
  detectPackageManager,
  logger,
  readJsonFile,
  validateDependency,
} from '@nx/devkit';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { importClosure } from '../utils/import-closure';
import {
  ENV_FILES,
  ORVAL_CONFIG_GLOB,
  type OrvalConfigSummary,
  containsPath,
  summarizeOrvalConfig,
} from '../utils/orval-config';
import { specRefFiles } from '../utils/spec-refs';

export interface OrvalPluginOptions {
  /** Name of the inferred target. Defaults to `orval`. */
  targetName?: string;
  /**
   * Cache targets whose spec is a remote URL. Off by default: Nx cannot hash a
   * URL, so a cached client stays stale until the config or Orval changes.
   */
  cacheRemoteSpecs?: boolean;
  /** Add a graph edge from each client to the project owning its local spec. Defaults to true. */
  inferDependencies?: boolean;
}

type NormalizedOptions = Required<OrvalPluginOptions>;

/** The expensive part of inferring a target: evaluating the Orval config. */
interface CachedEntry {
  readonly configFile: string;
  readonly summary: OrvalConfigSummary;
}

type Cache = Record<string, CachedEntry>;

/**
 * Carried on the inferred target so `createDependencies` can read it from the
 * project graph itself, in any process, whatever the state of the disk cache.
 */
interface OrvalTargetMetadata {
  readonly configFile: string;
  readonly specs: readonly string[];
}

/** Bumps cached targets whenever the plugin itself changes how it infers them. */
const PLUGIN_VERSION: string = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** Files that sit beside a spec but are never part of one. */
const NON_SPEC_FILES = '{package.json,project.json,tsconfig*.json}';

/**
 * How each package manager runs a locally installed binary, as in Nx's own
 * `getPackageManagerCommand().exec`. That helper spawns `<pm> --version`, which
 * is too slow to pay on every graph build.
 */
const EXEC_COMMANDS: Readonly<Record<ReturnType<typeof detectPackageManager>, string>> = {
  npm: 'npx',
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  bun: 'bun',
};

/** Formatter settings Orval's post-generation formatting reads from the workspace root. */
const FORMATTER_INPUTS = [
  '{workspaceRoot}/.prettierrc*',
  '{workspaceRoot}/prettier.config.*',
  '{workspaceRoot}/.prettierignore',
  '{workspaceRoot}/.editorconfig',
  '{workspaceRoot}/biome.json*',
  '{workspaceRoot}/.oxfmtrc*',
] as const;

const normalizeOptions = (options: OrvalPluginOptions | undefined): NormalizedOptions => ({
  targetName: options?.targetName ?? 'orval',
  cacheRemoteSpecs: options?.cacheRemoteSpecs ?? false,
  inferDependencies: options?.inferDependencies ?? true,
});

/** Parts are separated so adjacent values can never hash like one merged value. */
const hashOf = (...parts: Array<string | Buffer>): string =>
  parts
    .reduce((hash, part) => hash.update(part).update('\0'), createHash('sha256'))
    .digest('hex');

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Nx's workspace data directory: `NX_WORKSPACE_DATA_DIRECTORY`, else the legacy
 * `NX_PROJECT_GRAPH_CACHE_DIRECTORY`, else `.nx/workspace-data`, always
 * resolved against the workspace root (never the process cwd).
 */
const workspaceDataDirectory = (workspaceRoot: string): string => {
  const configured =
    process.env['NX_WORKSPACE_DATA_DIRECTORY'] ||
    process.env['NX_PROJECT_GRAPH_CACHE_DIRECTORY'] ||
    join('.nx', 'workspace-data');
  return isAbsolute(configured) ? configured : join(workspaceRoot, configured);
};

/** One cache file per plugin registration, in Nx's workspace data dir. */
const cachePathFor = (workspaceRoot: string, options: NormalizedOptions): string =>
  join(
    workspaceDataDirectory(workspaceRoot),
    `nx-orval-${hashOf(JSON.stringify(options)).slice(0, 12)}.hash.json`,
  );

const readCache = (path: string): Cache => {
  try {
    return existsSync(path) ? readJsonFile<Cache>(path) : {};
  } catch {
    return {};
  }
};

/**
 * Persists the cache through a temp file and a rename, so a concurrent reader
 * (daemon plus CLI, parallel CI jobs) sees either the old or the new file,
 * never half of one. The cache only saves work: a read-only or sandboxed
 * workspace must not fail the graph, so write errors are logged and dropped.
 */
const writeCache = (path: string, previous: Cache, next: Cache): void => {
  const serialized = JSON.stringify(next);
  if (serialized === JSON.stringify(previous)) return;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, serialized);
    renameSync(temp, path);
  } catch (error) {
    logger.verbose(`nx-orval: could not write the graph cache ${path}. ${String(error)}`);
    try {
      unlinkSync(temp);
    } catch {
      // The temp file was never created.
    }
  }
};

const isCachedEntry = (value: unknown): value is CachedEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<CachedEntry>).configFile === 'string' &&
  typeof (value as Partial<CachedEntry>).summary === 'object' &&
  (value as Partial<CachedEntry>).summary !== null;

/** Env files next to the config, which the config may read while it loads. */
const envFileContents = (workspaceRoot: string, configFile: string): string[] =>
  ENV_FILES.map((name) => join(workspaceRoot, dirname(configFile), name)).map((file) =>
    existsSync(file) ? readFileSync(file, 'utf8') : '',
  );

/**
 * Cache key: plugin version, config path and contents, project root, the
 * config's env files, every local module it imports, and options. Anything the
 * evaluated config can depend on has to be in here, or a stale summary (wrong
 * outputs, wrong specs) outlives the edit that made it wrong.
 */
const hashConfig = (
  workspaceRoot: string,
  configFile: string,
  projectRoot: string,
  imports: readonly string[],
  options: NormalizedOptions,
): string =>
  hashOf(
    PLUGIN_VERSION,
    configFile,
    projectRoot,
    readFileSync(join(workspaceRoot, configFile)),
    ...envFileContents(workspaceRoot, configFile),
    ...imports.flatMap((file) => [file, readText(join(workspaceRoot, file))]),
    JSON.stringify(options),
  );

const hasProjectFile = (workspaceRoot: string, folder: string): boolean => {
  const files = readdirSync(join(workspaceRoot, folder));
  return files.includes('project.json') || files.includes('package.json');
};

/**
 * Nearest folder at or above the config holding project.json or package.json.
 * Configs may sit in a subfolder (`src/lib/orval-config/`); the workspace root
 * only counts when the config is directly in it.
 */
const findProjectRoot = (workspaceRoot: string, configFile: string): string | undefined => {
  const configDir = dirname(configFile);
  if (configDir === '.') return hasProjectFile(workspaceRoot, '.') ? '.' : undefined;
  const walk = (folder: string): string | undefined => {
    if (folder === '.') return undefined;
    return hasProjectFile(workspaceRoot, folder) ? folder : walk(dirname(folder));
  };
  return walk(configDir);
};

const isOutsideWorkspace = (file: string): boolean => file === '..' || file.startsWith('../');

/** Output globs negated so generated files never feed their own hash. */
const excludeOutputs = (projectRoot: string, outputs: readonly string[]): string[] =>
  outputs
    .filter((output) => projectRoot === '.' || output.startsWith(`${projectRoot}/`))
    .map((output) => (projectRoot === '.' ? output : output.slice(projectRoot.length + 1)))
    .flatMap((relative) =>
      relative.includes('*')
        ? [`!{projectRoot}/${relative}`]
        : [`!{projectRoot}/${relative}`, `!{projectRoot}/${relative}/**/*`],
    );

/**
 * Local modules the config imports from outside the project. Those inside the
 * project are already covered by the project-wide input.
 */
const importInputs = (projectRoot: string, imports: readonly string[]): string[] =>
  imports
    .filter((file) => !isOutsideWorkspace(file) && !containsPath(projectRoot, file))
    .map((file) => `{workspaceRoot}/${file}`);

/**
 * Specs outside the project. Split specs (`$ref: './pet.yaml'`) are covered by
 * the spec-like files under the spec's folder, minus the package, project and
 * tsconfig files that live beside it, and by the `$ref` closure for specs in
 * the workspace root (where a folder glob would match the whole repo) or refs
 * that leave the folder.
 */
const specInputs = (
  projectRoot: string,
  specs: readonly string[],
  refFiles: readonly string[],
): string[] => {
  const outside = (file: string): boolean => !containsPath(projectRoot, file);
  const external = specs.filter(outside);
  const dirs = [
    ...new Set(external.map((spec) => posix.dirname(spec)).filter((dir) => dir !== '.')),
  ];
  const folderGlobs = dirs.flatMap((dir) => [
    `{workspaceRoot}/${dir}/**/*.{yaml,yml,json}`,
    // Negations apply to every input, so they are skipped when the folder
    // holds the project and would also hide the project's own files.
    ...(containsPath(dir, projectRoot) ? [] : [`!{workspaceRoot}/${dir}/**/${NON_SPEC_FILES}`]),
  ]);
  const files = [
    ...external,
    ...refFiles.filter((file) => outside(file) && !dirs.some((dir) => containsPath(dir, file))),
  ].map((file) => `{workspaceRoot}/${file}`);
  return [...new Set([...files, ...folderGlobs])];
};

/** Why the target is not cached, for people reading `nx show project`. */
const cacheOffReason = (
  summary: OrvalConfigSummary,
  options: NormalizedOptions,
): string | undefined =>
  summary.remoteSpecs.length > 0 && !options.cacheRemoteSpecs
    ? 'remote spec (set cacheRemoteSpecs to cache it)'
    : summary.cacheBlockers[0];

const targetDescription = (summary: OrvalConfigSummary, offReason: string | undefined): string =>
  `Generate API clients with Orval (${summary.projectNames.join(', ') || 'no projects'})${
    offReason ? `. Caching off: ${offReason}` : ''
  }`;

/** Orval's own `--project` flag filters to one key of the config. */
type TargetHelp = NonNullable<NonNullable<TargetConfiguration['metadata']>['help']>;

const helpFor = (exec: string, projectName: string | undefined): TargetHelp => ({
  command: `${exec} orval --help`,
  example: { options: { project: projectName ?? 'petstore' } },
});

interface BuildTargetInput {
  readonly configFile: string;
  readonly projectRoot: string;
  readonly summary: OrvalConfigSummary;
  readonly imports: readonly string[];
  readonly refFiles: readonly string[];
  readonly options: NormalizedOptions;
  /** Package manager's `exec` command, so help works for npm, pnpm, yarn and bun. */
  readonly exec: string;
}

const buildTarget = ({
  configFile,
  projectRoot,
  summary,
  imports,
  refFiles,
  options,
  exec,
}: BuildTargetInput): TargetConfiguration => {
  const offReason = cacheOffReason(summary, options);
  const metadata: OrvalTargetMetadata = { configFile, specs: summary.localSpecs };
  return {
    command: `orval --config ${basename(configFile)}`,
    options: { cwd: dirname(configFile) },
    cache: offReason === undefined,
    inputs: [
      // Project files cover the config plus local mutators, transformers and tsconfig.
      '{projectRoot}/**/*',
      ...excludeOutputs(projectRoot, summary.outputs),
      ...importInputs(projectRoot, imports),
      ...specInputs(projectRoot, summary.localSpecs, refFiles),
      ...FORMATTER_INPUTS,
      { externalDependencies: ['orval'] },
    ],
    outputs: summary.outputs.map((output) => `{workspaceRoot}/${output}`),
    metadata: {
      technologies: ['orval'],
      description: targetDescription(summary, offReason),
      help: helpFor(exec, summary.projectNames[0]),
      orval: metadata,
    },
  };
};

/** Target used when the config cannot be evaluated at graph time: runnable, never cached. */
const fallbackTarget = (configFile: string, exec: string): TargetConfiguration => ({
  command: `orval --config ${basename(configFile)}`,
  options: { cwd: dirname(configFile) },
  cache: false,
  metadata: {
    technologies: ['orval'],
    description: 'Generate API clients with Orval (config could not be analysed, caching off)',
    help: helpFor(exec, undefined),
  },
});

const analyse = async (
  configFile: string,
  projectRoot: string,
  context: CreateNodesContext,
): Promise<CachedEntry | undefined> => {
  try {
    const summary = await summarizeOrvalConfig(context.workspaceRoot, configFile, projectRoot);
    summary.cacheBlockers.forEach((reason) =>
      logger.verbose(`nx-orval: caching off for ${configFile}: ${reason}`),
    );
    return { configFile, summary };
  } catch (error) {
    logger.warn(
      `nx-orval: could not analyse ${configFile}, inferring an uncached target. ${String(error)}`,
    );
    return undefined;
  }
};

const createNodesInternal = async (
  configFile: string,
  options: NormalizedOptions,
  context: CreateNodesContext,
  exec: string,
  previous: Cache,
  next: Cache,
): Promise<CreateNodesResult> => {
  const projectRoot = findProjectRoot(context.workspaceRoot, configFile);
  if (projectRoot === undefined) return {};

  const imports = importClosure(context.workspaceRoot, configFile);
  const hash = hashConfig(context.workspaceRoot, configFile, projectRoot, imports, options);
  const cached = previous[hash];
  const entry = isCachedEntry(cached) ? cached : await analyse(configFile, projectRoot, context);
  if (entry) next[hash] = entry;

  // Built on every call from the cached summary: the file lists below are cheap
  // to read and must always match what is on disk.
  const target = entry
    ? buildTarget({
        configFile,
        projectRoot,
        summary: entry.summary,
        imports,
        refFiles: specRefFiles(context.workspaceRoot, entry.summary.localSpecs),
        options,
        exec,
      })
    : fallbackTarget(configFile, exec);

  return { projects: { [projectRoot]: { targets: { [options.targetName]: target } } } };
};

/** Infers an `orval` target for every project that has an Orval config. */
export const createNodes: CreateNodes<OrvalPluginOptions> = [
  ORVAL_CONFIG_GLOB,
  async (configFiles, rawOptions, context) => {
    const options = normalizeOptions(rawOptions);
    const cachePath = cachePathFor(context.workspaceRoot, options);
    const previous = readCache(cachePath);
    const next: Cache = {};
    const exec = EXEC_COMMANDS[detectPackageManager(context.workspaceRoot)] ?? 'npx';
    const results = await createNodesFromFiles(
      (configFile, _, ctx) => createNodesInternal(configFile, options, ctx, exec, previous, next),
      configFiles,
      options,
      context,
    );
    writeCache(cachePath, previous, next);
    return results;
  },
];

/** Alias for Nx versions that still look up `createNodesV2`. */
export const createNodesV2 = createNodes;

/** Finds the project that owns a workspace-relative file, by longest matching root. */
const owningProject = (
  file: string,
  projects: Record<string, { root: string }>,
): string | undefined =>
  Object.entries(projects)
    .filter(([, { root }]) => root === '.' || file === root || file.startsWith(`${root}/`))
    .sort(([, a], [, b]) => b.root.length - a.root.length)[0]?.[0];

const isValid = (
  dependency: RawProjectGraphDependency,
  context: Parameters<CreateDependencies>[1],
): boolean => {
  try {
    validateDependency(dependency, context);
    return true;
  } catch {
    return false;
  }
};

const readOrvalMetadata = (
  target: TargetConfiguration | undefined,
): OrvalTargetMetadata | undefined => {
  const value: unknown = target?.metadata?.['orval'];
  if (typeof value !== 'object' || value === null) return undefined;
  const { configFile, specs } = value as Partial<Record<keyof OrvalTargetMetadata, unknown>>;
  return typeof configFile === 'string' &&
    Array.isArray(specs) &&
    specs.every((spec): spec is string => typeof spec === 'string')
    ? { configFile, specs }
    : undefined;
};

/**
 * Links each Orval client to the project that owns its local spec, so a spec
 * change marks the client (and its dependents) affected. Reads the metadata
 * createNodes put on each inferred target, so it works in any process that
 * builds the graph, with no dependence on files on disk.
 */
export const createDependencies: CreateDependencies<OrvalPluginOptions> = (rawOptions, context) => {
  const options = normalizeOptions(rawOptions);
  if (!options.inferDependencies) return [];

  return Object.entries(context.projects).flatMap(([source, project]) => {
    const metadata = readOrvalMetadata(project.targets?.[options.targetName]);
    if (!metadata) return [];
    return [...new Set(metadata.specs.map((spec) => owningProject(spec, context.projects)))]
      .filter((target): target is string => !!target && target !== source)
      .map(
        (target): RawProjectGraphDependency => ({
          source,
          target,
          sourceFile: metadata.configFile,
          type: DependencyType.static,
        }),
      )
      .filter((dependency) => isValid(dependency, context));
  });
};
