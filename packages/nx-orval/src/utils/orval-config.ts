import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { createJiti } from 'jiti';

/** Config extensions the plugin and executor recognise (Orval loads all of them via jiti). */
export const ORVAL_CONFIG_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;

export const ORVAL_CONFIG_NAMES = ORVAL_CONFIG_EXTENSIONS.map((ext) => `orval.config.${ext}`);

export const ORVAL_CONFIG_GLOB = `**/orval.config.{${ORVAL_CONFIG_EXTENSIONS.join(',')}}`;

/** Output modes that write one file family (`<name>.*`) next to `output.target`. */
const FILE_FAMILY_MODES = new Set(['single', 'split']);

/** What Nx needs to know about one Orval config: what it reads and what it writes. */
export interface OrvalConfigSummary {
  /** Local spec files, workspace-relative. */
  readonly localSpecs: readonly string[];
  /** Remote spec URLs. Nx cannot hash these. */
  readonly remoteSpecs: readonly string[];
  /** Generated paths or globs, workspace-relative. */
  readonly outputs: readonly string[];
  /** Orval project keys defined in the config. */
  readonly projectNames: readonly string[];
  /**
   * Reasons the target must not be cached: an input Nx cannot track, or an
   * output that would let a cache restore overwrite hand-written files.
   */
  readonly cacheBlockers: readonly string[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRemote = (target: string): boolean => /^https?:\/\//i.test(target);

const toPosix = (path: string): string => path.split('\\').join('/');

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const ENV_FILES = ['.env.local', '.env', '.env.example'] as const;

const parseEnvFile = (content: string): Array<[string, string]> =>
  content.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) return [];
    return [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]];
  });

/**
 * Configs commonly `import 'dotenv/config'`, which reads `.env` from the cwd.
 * At graph time the cwd is the workspace root, so the config's own env files
 * are applied for the duration of the load, without overriding real variables.
 * `.env.example` is the last resort so the config's shape stays readable.
 */
/** Serialises env-patched loads so concurrent configs never see each other's variables. */
let envQueue: Promise<unknown> = Promise.resolve();

export const withConfigEnv = <T>(configDir: string, load: () => Promise<T>): Promise<T> => {
  const run = envQueue.then(() => applyEnvAndLoad(configDir, load));
  envQueue = run.catch(() => undefined);
  return run;
};

const applyEnvAndLoad = async <T>(configDir: string, load: () => Promise<T>): Promise<T> => {
  const applied: string[] = [];
  ENV_FILES.map((name) => join(configDir, name))
    .filter((file) => existsSync(file))
    .forEach((file) =>
      parseEnvFile(readFileSync(file, 'utf8')).forEach(([key, value]) => {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          applied.push(key);
        }
      }),
    );
  try {
    return await load();
  } finally {
    applied.forEach((key) => delete process.env[key]);
  }
};

/** Loads an Orval config the same way the Orval CLI does (jiti, default export, optional factory). */
export const loadOrvalConfig = async (configPath: string): Promise<UnknownRecord> => {
  const jiti = createJiti(configPath, { interopDefault: true, moduleCache: false });
  const config = await withConfigEnv(dirname(configPath), async () => {
    const exported = await jiti.import<unknown>(configPath, { default: true });
    return typeof exported === 'function' ? await exported() : await exported;
  });
  if (!isRecord(config)) {
    throw new Error(`${configPath} must default-export an Orval config object`);
  }
  return config;
};

/** Resolves each Orval project entry, which may itself be a factory or promise. */
const resolveProjects = async (config: UnknownRecord): Promise<Array<[string, UnknownRecord]>> => {
  const entries = Object.entries(config).filter(([key]) => key !== 'logLevel');
  const resolved = await Promise.all(
    entries.map(async ([name, value]): Promise<[string, unknown]> => [
      name,
      typeof value === 'function' ? await value() : await value,
    ]),
  );
  return resolved.filter((entry): entry is [string, UnknownRecord] => isRecord(entry[1]));
};

const stringTargets = (target: unknown): string[] => {
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === 'string');
  return [];
};

/** Spec targets of one project. Orval accepts a string, an array, or `{ target }`. */
const inputTargets = (input: unknown): string[] =>
  isRecord(input) ? stringTargets(input['target']) : stringTargets(input);

const schemasPath = (schemas: unknown): string | undefined =>
  isRecord(schemas) ? asString(schemas['path']) : asString(schemas);

/**
 * Paths Orval writes for one project, relative to the config dir.
 * Single/split modes write `<name>.*` files beside the target, so a glob keeps
 * hand-written neighbours out of the cache. Tag modes own the target directory.
 */
const outputPaths = (output: unknown): string[] => {
  if (typeof output === 'string') return [output];
  if (!isRecord(output)) return [];

  const workspace = asString(output['workspace']);
  if (workspace !== undefined) return [workspace];

  const target = asString(output['target']);
  const mode = asString(output['mode']) ?? 'single';
  const extras = [schemasPath(output['schemas']), asString(output['operationSchemas'])];

  const targetPaths = (): string[] => {
    if (!target) return [];
    const ext = extname(target);
    if (!ext) return [target];
    if (!FILE_FAMILY_MODES.has(mode)) return [dirname(target)];
    return [`${target.slice(0, -ext.length)}.*`];
  };

  return [...targetPaths(), ...extras.filter((p): p is string => !!p)];
};

const toWorkspacePath = (workspaceRoot: string, configDir: string, path: string): string =>
  toPosix(relative(workspaceRoot, isAbsolute(path) ? path : resolve(configDir, path))) || '.';

const isOutsideWorkspace = (path: string): boolean => path === '..' || path.startsWith('../');

/** True when `ancestor` is `path` itself or one of its parent folders. */
export const containsPath = (ancestor: string, path: string): boolean =>
  ancestor === '.' || ancestor === path || path.startsWith(`${ancestor}/`);

/** Drops paths already covered by a parent directory in the same list. */
const dedupeNested = (paths: readonly string[]): string[] => {
  const unique = [...new Set(paths.map((p) => toPosix(normalize(p))))];
  return unique.filter((path) => !unique.some((other) => other !== path && containsPath(other, path)));
};

/** Summarises an Orval config into the inputs and outputs Nx caches on. */
export const summarizeOrvalConfig = async (
  workspaceRoot: string,
  configFile: string,
  projectRoot: string = toPosix(dirname(configFile)) || '.',
): Promise<OrvalConfigSummary> => {
  const configPath = join(workspaceRoot, configFile);
  const configDir = dirname(configPath);
  const projects = await resolveProjects(await loadOrvalConfig(configPath));

  const targets = projects.flatMap(([, options]) => inputTargets(options['input']));
  const remoteSpecs = [...new Set(targets.filter(isRemote))];
  const localSpecs = [
    ...new Set(
      targets
        .filter((target) => !isRemote(target))
        .map((target) => toWorkspacePath(workspaceRoot, configDir, target)),
    ),
  ];
  const outputs = dedupeNested(
    projects
      .flatMap(([, options]) => outputPaths(options['output']))
      .map((path) => toWorkspacePath(workspaceRoot, configDir, path)),
  );

  const cacheBlockers = [
    ...localSpecs.filter(isOutsideWorkspace).map((spec) => `spec ${spec} is outside the workspace`),
    ...outputs.filter(isOutsideWorkspace).map((out) => `output ${out} is outside the workspace`),
    ...outputs
      .filter((out) => !isOutsideWorkspace(out) && containsPath(out, projectRoot))
      .map((out) => `output ${out} contains the project root; use a dedicated folder`),
    ...(outputs.length === 0 ? ['no output paths found in the config'] : []),
  ];

  return {
    localSpecs: localSpecs.filter((spec) => !isOutsideWorkspace(spec)),
    remoteSpecs,
    outputs: outputs.filter(
      (out) => !isOutsideWorkspace(out) && !containsPath(out, projectRoot),
    ),
    projectNames: projects.map(([name]) => name),
    cacheBlockers,
  };
};
