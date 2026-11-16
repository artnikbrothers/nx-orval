import {
  NX_VERSION,
  type GeneratorCallback,
  type Tree,
  addDependenciesToPackageJson,
  ensurePackage,
  formatFiles,
  getDependencyVersionFromPackageJson,
  getPackageManagerCommand,
  getProjects,
  joinPathFragments,
  logger,
  normalizePath,
  parseJson,
  readJson,
  readProjectConfiguration,
  runTasksInSerial,
  updateJson,
  workspaceRoot,
} from '@nx/devkit';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { ORVAL_CONFIG_NAMES } from '../../utils/orval-config';
import { ORVAL_VERSION, registerOrval, registeredTargetName } from '../init/generator';
import type {
  ApiGeneratorSchema,
  OrvalClient,
  OrvalFormatter,
  OrvalHttpClient,
  OrvalValidation,
} from './schema';
import { defaultLibraryRoot, isCoveredByGlobs, readWorkspaceGlobs } from './workspace-globs';

const SAMPLE_SPEC = join(__dirname, 'files', 'sample', 'openapi.yaml');

const SPEC_NAMES = ['openapi.yaml', 'openapi.yml', 'openapi.json'];

/** Root JSON files @nx/js reserialises even when their content does not change. */
const ROOT_JSON_FILES = ['nx.json', 'tsconfig.base.json', 'tsconfig.json'];

const GENERATED_DIR = 'src/generated';

/** Orval output folders, one per config entry, so `clean` in one never wipes the other. */
const CLIENT_DIR = `${GENERATED_DIR}/client`;
const validationDir = (validation: OrvalValidation): string => `${GENERATED_DIR}/${validation}`;

/** Clients that generate schemas only, so a separate validation entry would duplicate them. */
const SCHEMA_CLIENTS: readonly OrvalClient[] = ['zod', 'valibot'];

/** Formatters Orval supports, in the order they win when a workspace has several. */
const FORMATTER_PACKAGES: ReadonlyArray<readonly [string, OrvalFormatter]> = [
  ['oxfmt', 'oxfmt'],
  ['@biomejs/biome', 'biome'],
  ['prettier', 'prettier'],
];

interface NormalizedOptions {
  readonly name: string;
  readonly projectRoot: string;
  readonly isNewProject: boolean;
  readonly spec: string;
  /** True when the user named a spec; otherwise a new library starts from the sample. */
  readonly specProvided: boolean;
  readonly client: OrvalClient;
  readonly httpClient?: OrvalHttpClient;
  readonly validation?: OrvalValidation;
  readonly formatter?: OrvalFormatter;
  readonly mock: boolean;
  readonly tags?: string;
  readonly linter?: 'eslint' | 'none';
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** Spec path as seen from the Orval config, which resolves paths relative to itself. */
const specFromConfig = (projectRoot: string, spec: string): string => {
  if (isUrl(spec)) return spec;
  const relativeSpec = posix.relative(projectRoot, spec);
  return relativeSpec.startsWith('.') ? relativeSpec : `./${relativeSpec}`;
};

/** The invocation directory relative to the workspace root, resolved the way Nx generators resolve it. */
const relativeCwd = (): string => {
  const cwd = process.env.INIT_CWD?.startsWith(workspaceRoot)
    ? process.env.INIT_CWD
    : process.cwd();
  return normalizePath(relative(workspaceRoot, cwd)).replace(/\/$/, '');
};

/** `--directory` is relative to the current directory, like in every Nx generator. */
const resolveDirectory = (directory: string): string => {
  const cwd = relativeCwd();
  return directory === cwd || directory.startsWith(`${cwd}/`)
    ? directory
    : joinPathFragments(cwd, directory);
};

/** The formatter the workspace already uses, so generated code matches the rest of the repo. */
const detectFormatter = (tree: Tree): OrvalFormatter | undefined =>
  FORMATTER_PACKAGES.find(([pkg]) => getDependencyVersionFromPackageJson(tree, pkg) !== null)?.[1];

/** A validation entry next to a schema-only client of the same kind would generate the same files twice. */
const normalizeValidation = (
  client: OrvalClient,
  validation: OrvalValidation | 'none' | undefined,
): OrvalValidation | undefined => {
  if (!validation || validation === 'none') return undefined;
  if (client === validation) {
    logger.warn(`nx-orval: --client=${client} already generates ${validation} schemas, skipping --validation.`);
    return undefined;
  }
  return validation;
};

/** Clients whose HTTP layer Orval lets you choose. */
const HTTP_CLIENT_CLIENTS: readonly OrvalClient[] = [
  'react-query',
  'vue-query',
  'svelte-query',
  'solid-query',
  'swr',
];

const normalizeHttpClient = (
  client: OrvalClient,
  httpClient: OrvalHttpClient | undefined,
): OrvalHttpClient | undefined => {
  if (!httpClient || HTTP_CLIENT_CLIENTS.includes(client)) return httpClient;
  logger.warn(`nx-orval: --httpClient applies to ${HTTP_CLIENT_CLIENTS.join(', ')}; ignored for --client=${client}.`);
  return undefined;
};

const normalizeMock = (client: OrvalClient, mock: boolean | undefined): boolean => {
  if (mock && SCHEMA_CLIENTS.includes(client)) {
    logger.warn(`nx-orval: --client=${client} generates schemas only, so --mock is ignored.`);
    return false;
  }
  return mock ?? false;
};

/** The Orval project key: the given name, or the project's own name when adding to an existing project. */
const apiName = (options: ApiGeneratorSchema): string => {
  const name = options.name?.trim();
  if (name) return name;
  if (options.project) return posix.basename(options.project).replace(/[^a-zA-Z0-9._-]/g, '-');
  throw new Error(
    'Name the API (nx g nx-orval:api <name>) or pass --project to add Orval to an existing project.',
  );
};

/** Package-manager workspaces only link packages inside their globs, so a new library has to sit in one. */
const assertCoveredByWorkspaces = (projectRoot: string, globs: readonly string[] | undefined): void => {
  if (globs && !isCoveredByGlobs(projectRoot, globs)) {
    throw new Error(
      `${projectRoot} is not covered by the workspaces globs [${globs.join(', ')}], so the package manager would not link the new library. Pass --directory with a folder under one of them.`,
    );
  }
};

const assertNoOrvalConfig = (tree: Tree, projectRoot: string): void => {
  const existingConfig = ORVAL_CONFIG_NAMES.map((name) => joinPathFragments(projectRoot, name)).find(
    (path) => tree.exists(path),
  );
  if (existingConfig) {
    throw new Error(`${existingConfig} already exists. Add the API to that config by hand.`);
  }
};

const normalizeOptions = (tree: Tree, options: ApiGeneratorSchema): NormalizedOptions => {
  const name = apiName(options);
  const isNewProject = !options.project;
  const globs = readWorkspaceGlobs(tree);
  const projectRoot = options.project
    ? readProjectConfiguration(tree, options.project).root
    : options.directory
      ? resolveDirectory(options.directory)
      : joinPathFragments(defaultLibraryRoot(globs), name);
  if (isNewProject) assertCoveredByWorkspaces(projectRoot, globs);
  assertNoOrvalConfig(tree, projectRoot);
  // An empty answer to the spec prompt means "no spec given".
  const providedSpec = options.spec?.trim() || undefined;
  const existingSpec = SPEC_NAMES.map((specName) => joinPathFragments(projectRoot, specName)).find((path) =>
    tree.exists(path),
  );
  if (!isNewProject && !providedSpec && !existingSpec) {
    throw new Error(
      `No OpenAPI spec found in ${projectRoot}. Pass --spec=<path or URL>, or add an openapi.yaml there.`,
    );
  }
  const spec = providedSpec ?? existingSpec ?? joinPathFragments(projectRoot, 'openapi.yaml');
  if (providedSpec && !isUrl(spec) && !tree.exists(spec)) {
    throw new Error(`Spec ${spec} does not exist in the workspace`);
  }
  const client = options.client ?? 'fetch';
  return {
    name,
    projectRoot,
    isNewProject,
    spec,
    specProvided: providedSpec !== undefined,
    client,
    httpClient: normalizeHttpClient(client, options.httpClient),
    validation: normalizeValidation(client, options.validation),
    formatter: detectFormatter(tree),
    mock: normalizeMock(client, options.mock),
    tags: options.tags,
    linter: options.linter,
  };
};

/** Serialises user input as a TS string literal, so quotes in paths or URLs stay data. */
const literal = (value: string): string => JSON.stringify(value);

/** Shared output options: one file per OpenAPI tag, a stable header, the workspace formatter. */
const commonOutput = (options: NormalizedOptions, tsconfig: string | undefined): string[] => [
  `      mode: 'tags',`,
  `      clean: true,`,
  ...(options.formatter ? [`      formatter: ${literal(options.formatter)},`] : []),
  ...(tsconfig ? [`      tsconfig: ${literal(tsconfig)},`] : []),
  `      override: {`,
  `        header,`,
  `      },`,
];

const configEntry = (key: string, specTarget: string, outputLines: readonly string[]): string =>
  [
    `  ${literal(key)}: {`,
    `    input: {`,
    `      target: ${specTarget},`,
    `    },`,
    `    output: {`,
    ...outputLines,
    `    },`,
    `  },`,
  ].join('\n');

export const orvalConfigSource = (options: NormalizedOptions, tsconfig?: string): string => {
  const specTarget = literal(specFromConfig(options.projectRoot, options.spec));
  const isSchemaClient = SCHEMA_CLIENTS.includes(options.client);
  const clientEntry = configEntry(options.name, specTarget, [
    `      workspace: './${CLIENT_DIR}',`,
    `      target: ${literal(`./${options.name}.ts`)},`,
    ...(isSchemaClient
      ? []
      : [`      schemas: './models',`, `      operationSchemas: './models/operations',`]),
    `      indexFiles: true,`,
    `      client: ${literal(options.client)},`,
    ...(options.httpClient ? [`      httpClient: ${literal(options.httpClient)},`] : []),
    ...(isSchemaClient ? [] : [`      mock: ${options.mock},`]),
    ...commonOutput(options, tsconfig),
  ]);
  const validationEntry = options.validation
    ? configEntry(`${options.name}-${options.validation}`, specTarget, [
        `      workspace: './${validationDir(options.validation)}',`,
        `      target: ${literal(`./${options.name}.ts`)},`,
        `      indexFiles: true,`,
        `      client: ${literal(options.validation)},`,
        ...commonOutput(options, tsconfig),
      ])
    : undefined;
  return `import { defineConfig } from 'orval';

/** Stable header: no Orval version, so upgrading Orval does not touch every generated file. */
const header = (info: { title?: string }): string[] => [
  'Generated by Orval. Do not edit manually.',
  ...(info.title ? [info.title] : []),
];

export default defineConfig({
${[clientEntry, validationEntry].filter(Boolean).join('\n')}
});
`;
};

/** Validation schemas share names with client types, so they get their own namespace. */
const indexSource = (validation: OrvalValidation | undefined): string =>
  [
    `export * from './generated/client';`,
    ...(validation ? [`export * as ${validation} from './generated/${validation}';`] : []),
    '',
  ].join('\n');

interface LibraryNames {
  readonly projectName: string;
  readonly importPath: string;
  readonly targetName: string;
}

export const readmeSource = (options: NormalizedOptions, names: LibraryNames): string => {
  const spec = isUrl(options.spec)
    ? options.spec
    : specFromConfig(options.projectRoot, options.spec);
  return `# ${names.importPath}

Typed \`${options.client}\` API client, generated by [Orval](https://orval.dev) from \`${spec}\`.

## Regenerate

\`\`\`bash
npx nx run ${names.projectName}:${names.targetName}
\`\`\`

Nx caches the result and only reruns Orval when the spec or \`orval.config.ts\` changes.

## Use

\`\`\`ts
import { ... } from '${names.importPath}';
\`\`\`

## Files

| Path | Contents |
| --- | --- |
| \`orval.config.ts\` | Spec location and Orval options |
| \`${CLIENT_DIR}/\` | Generated client, one file per API tag, models in \`models/\` |${
    options.validation
      ? `\n| \`${validationDir(options.validation)}/\` | Generated ${options.validation} schemas, exported as \`${options.validation}\` |`
      : ''
  }
| \`${GENERATED_DIR}/\` | Generated code. Do not edit: every run overwrites it |
| \`src/index.ts\` | Public exports |
`;
};

type LibraryGenerator = typeof import('@nx/js').libraryGenerator;

/** Loads @nx/js at the workspace's Nx version, installing it on the fly when it is missing. */
const loadLibraryGenerator = (): LibraryGenerator =>
  ensurePackage<typeof import('@nx/js')>('@nx/js', NX_VERSION).libraryGenerator;

interface TsconfigJson {
  readonly extends?: string | readonly string[];
  readonly compilerOptions?: {
    readonly module?: string;
    readonly moduleResolution?: string;
  };
}

interface ModuleSettings {
  readonly module?: string;
  readonly moduleResolution?: string;
}

/** Resolution modes that require explicit file extensions on relative imports in ESM files. */
const NODE_RESOLUTIONS = ['node16', 'nodenext'];

/** `module` values that imply one of those resolution modes when `moduleResolution` is not set. */
const NODE_MODULES = ['node16', 'node18', 'node20', 'nodenext'];

/** `module` and `moduleResolution` of a tsconfig, each taken from the closest file that sets it along relative `extends`. */
const moduleSettings = (
  tree: Tree,
  tsconfigPath: string,
  visited: readonly string[] = [],
): ModuleSettings => {
  if (visited.includes(tsconfigPath) || !tree.exists(tsconfigPath)) return {};
  const json = readJson<TsconfigJson>(tree, tsconfigPath);
  const parents = (Array.isArray(json.extends) ? json.extends : [json.extends]).filter(
    (parent): parent is string => typeof parent === 'string' && parent.startsWith('.'),
  );
  const inherited = parents
    .map((parent) => posix.join(posix.dirname(tsconfigPath), parent))
    .map((parent) => (parent.endsWith('.json') ? parent : `${parent}.json`))
    .reduce<ModuleSettings>(
      (merged, parent) => ({ ...merged, ...moduleSettings(tree, parent, [...visited, tsconfigPath]) }),
      {},
    );
  const { module, moduleResolution } = json.compilerOptions ?? {};
  return {
    ...inherited,
    ...(module !== undefined && { module: module.toLowerCase() }),
    ...(moduleResolution !== undefined && { moduleResolution: moduleResolution.toLowerCase() }),
  };
};

const requiresFileExtensions = ({ module, moduleResolution }: ModuleSettings): boolean =>
  moduleResolution !== undefined
    ? NODE_RESOLUTIONS.includes(moduleResolution)
    : module !== undefined && NODE_MODULES.includes(module);

/** Orval writes extensionless relative imports, which Node16/NodeNext resolution rejects, also when inherited. */
const useBundlerResolution = (tree: Tree, projectRoot: string): void => {
  const tsconfigLib = joinPathFragments(projectRoot, 'tsconfig.lib.json');
  if (!tree.exists(tsconfigLib)) return;
  if (!requiresFileExtensions(moduleSettings(tree, tsconfigLib))) return;
  updateJson<TsconfigJson>(tree, tsconfigLib, (json) => ({
    ...json,
    compilerOptions: { ...json.compilerOptions, module: 'esnext', moduleResolution: 'bundler' },
  }));
};

interface PackageJsonNx {
  name?: string;
  nx?: { name?: string };
}

/**
 * Lets the package name be the project name, like libraries written by hand in a workspaces setup.
 * Keeps the override when another project already uses the package name.
 */
const dropNxNameOverride = (tree: Tree, projectRoot: string, takenNames: Set<string>): void => {
  const packageJsonPath = joinPathFragments(projectRoot, 'package.json');
  if (!tree.exists(packageJsonPath)) return;
  updateJson<PackageJsonNx>(tree, packageJsonPath, (json) => {
    if (!json.nx?.name || (json.name !== undefined && takenNames.has(json.name))) return json;
    const updated: PackageJsonNx = { ...json, nx: { ...json.nx } };
    delete updated.nx?.name;
    if (updated.nx && Object.keys(updated.nx).length === 0) delete updated.nx;
    return updated;
  });
};

/** Flat ESLint config: a lone `ignores` entry is a global ignore for this project. */
const ignoreGeneratedCodeInLint = (tree: Tree, projectRoot: string): void => {
  const configPath = ['eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.js']
    .map((name) => joinPathFragments(projectRoot, name))
    .find((path) => tree.exists(path));
  if (!configPath) return;
  const source = tree.read(configPath, 'utf8') ?? '';
  const updated = source.replace(
    /(export default \[|module\.exports = \[)/,
    `$1\n  { ignores: ['**/${GENERATED_DIR}/**'] },`,
  );
  if (updated === source) {
    logger.warn(
      `nx-orval: could not add an ignore for ${GENERATED_DIR} to ${configPath}; add { ignores: ['**/${GENERATED_DIR}/**'] } by hand.`,
    );
    return;
  }
  tree.write(configPath, updated);
};

const isSameJson = (a: string, b: string): boolean => {
  try {
    return JSON.stringify(parseJson(a)) === JSON.stringify(parseJson(b));
  } catch {
    return false;
  }
};

const snapshot = (tree: Tree, paths: readonly string[]): Map<string, string> =>
  new Map(
    paths.flatMap((path) => {
      const content = tree.read(path, 'utf8');
      return content === null ? [] : [[path, content] as const];
    }),
  );

/** Restores the original bytes (comments, formatting) of files whose content did not change. */
const restoreUnchanged = (tree: Tree, before: Map<string, string>): void => {
  for (const [path, original] of before) {
    const current = tree.read(path, 'utf8');
    if (current !== null && current !== original && isSameJson(original, current)) {
      tree.write(path, original);
    }
  }
};

const libraryNames = (tree: Tree, options: NormalizedOptions): LibraryNames => {
  const packageJsonPath = joinPathFragments(options.projectRoot, 'package.json');
  const packageJson = tree.exists(packageJsonPath)
    ? readJson<PackageJsonNx>(tree, packageJsonPath)
    : undefined;
  if (packageJson?.name) {
    return {
      projectName: packageJson.nx?.name ?? packageJson.name,
      importPath: packageJson.name,
      targetName: registeredTargetName(tree),
    };
  }
  const paths: Record<string, string[]> = tree.exists('tsconfig.base.json')
    ? (readJson<{ compilerOptions?: { paths?: Record<string, string[]> } }>(tree, 'tsconfig.base.json')
        .compilerOptions?.paths ?? {})
    : {};
  const alias = Object.entries(paths).find(([, targets]) =>
    targets.some((target) =>
      normalizePath(target).replace(/^\.\//, '').startsWith(`${options.projectRoot}/`),
    ),
  )?.[0];
  return { projectName: options.name, importPath: alias ?? options.name, targetName: registeredTargetName(tree) };
};

/** Creates the library with @nx/js, so it follows the workspace layout (package manager workspaces or path aliases). */
const createLibrary = async (
  tree: Tree,
  options: NormalizedOptions,
): Promise<GeneratorCallback> => {
  if (tree.exists(options.projectRoot) && tree.children(options.projectRoot).length > 0) {
    throw new Error(
      `${options.projectRoot} already exists. Pass --project to add Orval to an existing project.`,
    );
  }
  const libraryGenerator = loadLibraryGenerator();
  const takenNames = new Set(getProjects(tree).keys());
  const rootJsonBefore = snapshot(tree, ROOT_JSON_FILES);
  const install = await libraryGenerator(tree, {
    directory: posix.relative(relativeCwd(), options.projectRoot) || '.',
    name: options.name,
    bundler: 'none',
    formatter: 'none',
    unitTestRunner: 'none',
    linter: options.linter,
    tags: options.tags,
    skipFormat: true,
    // The exported libraryGenerator forces project.json (and, before Nx 24, addPlugin: false).
    // Undefined lets it follow the workspace layout like the CLI does.
    useProjectJson: undefined,
    ...({ addPlugin: undefined } as object),
  });
  tree.delete(joinPathFragments(options.projectRoot, 'src/lib'));
  useBundlerResolution(tree, options.projectRoot);
  dropNxNameOverride(tree, options.projectRoot, takenNames);
  ignoreGeneratedCodeInLint(tree, options.projectRoot);
  restoreUnchanged(tree, rootJsonBefore);
  tree.write(joinPathFragments(options.projectRoot, 'src/index.ts'), indexSource(options.validation));
  tree.write(
    joinPathFragments(options.projectRoot, 'README.md'),
    readmeSource(options, libraryNames(tree, options)),
  );
  return install;
};

/** Options that only shape a new library. */
const warnIgnoredOptions = (rawOptions: ApiGeneratorSchema): void => {
  const ignored = (['directory', 'tags', 'linter'] as const).filter(
    (key) => rawOptions[key] !== undefined,
  );
  if (rawOptions.project && ignored.length > 0) {
    logger.warn(
      `nx-orval: --${ignored.join(', --')} only apply to a new library and are ignored with --project.`,
    );
  }
};

/** The project's TS config as seen from the Orval config, so Orval follows its compiler options. */
const projectTsconfig = (tree: Tree, projectRoot: string): string | undefined =>
  ['tsconfig.lib.json', 'tsconfig.json']
    .filter((name) => tree.exists(joinPathFragments(projectRoot, name)))
    .map((name) => `./${name}`)[0];

/**
 * Highest lower bound among the `||` alternatives of a range, so `^7 || ^8` counts as allowing 8.
 * Undefined when no alternative names a version (`latest`, `catalog:`, `workspace:*`).
 */
const minimumVersion = (range: string): readonly [number, number] | undefined =>
  range
    .split('||')
    .map((clause) => /(\d+)\.(\d+)/.exec(clause))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2])] as const)
    .sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];

const isBelow = (version: readonly [number, number], [major, minor]: readonly [number, number]): boolean =>
  version[0] < major || (version[0] === major && version[1] < minor);

/** The config uses Orval 8 options (formatter, operationSchemas); valibot output needs Orval 8.48. */
const checkOrvalVersion = (tree: Tree, options: NormalizedOptions): void => {
  const range = getDependencyVersionFromPackageJson(tree, 'orval');
  const installed = range ? minimumVersion(range) : undefined;
  if (!installed) return;
  if (isBelow(installed, [8, 0])) {
    throw new Error(
      `nx-orval:api writes an Orval 8 config, but the workspace has orval ${range}. Upgrade orval to ${ORVAL_VERSION} first.`,
    );
  }
  const usesValibot = options.client === 'valibot' || options.validation === 'valibot';
  if (usesValibot && isBelow(installed, [8, 48])) {
    logger.warn(`nx-orval: valibot output needs orval 8.48 or newer, the workspace has ${range}.`);
  }
};

/** Packages the generated code imports. Framework clients (Angular, Hono, Effect, MCP, ...) expect the app to have them. */
const RUNTIME_PACKAGES: Partial<Record<OrvalClient | OrvalValidation | OrvalHttpClient, Record<string, string>>> = {
  axios: { axios: '^1.0.0' },
  'axios-functions': { axios: '^1.0.0' },
  'react-query': { '@tanstack/react-query': '^5.0.0' },
  'vue-query': { '@tanstack/vue-query': '^5.0.0' },
  'svelte-query': { '@tanstack/svelte-query': '^5.0.0' },
  'solid-query': { '@tanstack/solid-query': '^5.0.0' },
  swr: { swr: '^2.0.0' },
  zod: { zod: '^4.0.0' },
  valibot: { valibot: '^1.0.0' },
};

const MOCK_PACKAGES = { msw: '^2.0.0', '@faker-js/faker': '^9.0.0' };

/** Adds what the generated code imports, keeping any version the workspace already has. */
const addRuntimeDependencies = (tree: Tree, options: NormalizedOptions): GeneratorCallback => {
  const keys = [options.client, options.httpClient, options.validation].filter(
    (key): key is OrvalClient | OrvalValidation | OrvalHttpClient => key !== undefined,
  );
  const dependencies = Object.assign({}, ...keys.map((key) => RUNTIME_PACKAGES[key] ?? {}));
  const devDependencies = options.mock ? MOCK_PACKAGES : {};
  return addDependenciesToPackageJson(tree, dependencies, devDependencies, undefined, true);
};

/** An existing project gets no index file, so say where the validation schemas land. */
const noteValidationPath = (options: NormalizedOptions): void => {
  if (options.isNewProject || !options.validation) return;
  logger.info(
    `nx-orval: ${options.validation} schemas go to ${joinPathFragments(options.projectRoot, validationDir(options.validation))}; export them from the project entry point if consumers need them.`,
  );
};

/** Quotes an argument only when a shell would otherwise interpret it. */
const shellArg = (value: string): string =>
  /^[\w@./:-]+$/.test(value) ? value : `"${value.replace(/["$`\\]/g, '\\$&')}"`;

/** The command that creates the generated code, spelled for the workspace's package manager. */
const generateCommand = (projectName: string, targetName: string): string =>
  `${getPackageManagerCommand().exec} nx run ${shellArg(`${projectName}:${targetName}`)}`;

/**
 * Runs the Orval target once after install, so the library compiles and its consumers resolve it.
 * A failure (offline, spec not reachable) only warns: the files the generator wrote stay valid.
 */
const generateOnce = (projectName: string, targetName: string, skip: boolean): GeneratorCallback => () => {
  const command = generateCommand(projectName, targetName);
  if (skip) {
    logger.info(`nx-orval: ${GENERATED_DIR} does not exist yet. Create it with: ${command}`);
    return;
  }
  try {
    execSync(command, { cwd: workspaceRoot, stdio: 'inherit' });
  } catch {
    logger.warn(`nx-orval: the first generation failed, so ${GENERATED_DIR} is missing. Run it by hand: ${command}`);
  }
};

/** The Nx project that owns the new Orval config. */
const projectNameOf = (tree: Tree, options: NormalizedOptions, rawOptions: ApiGeneratorSchema): string =>
  rawOptions.project ?? libraryNames(tree, options).projectName;

/** Adds an Orval-generated API client: a new library, or a config in an existing project. */
export async function apiGenerator(
  tree: Tree,
  rawOptions: ApiGeneratorSchema,
): Promise<GeneratorCallback> {
  warnIgnoredOptions(rawOptions);
  const options = normalizeOptions(tree, rawOptions);
  checkOrvalVersion(tree, options);
  const configPath = joinPathFragments(options.projectRoot, 'orval.config.ts');

  // Library tasks run first: @nx/js force-installs, which also covers the orval dependency init adds.
  const tasks: GeneratorCallback[] = [];
  if (options.isNewProject) tasks.push(await createLibrary(tree, options));
  tasks.push(registerOrval(tree, {}));
  tasks.push(addRuntimeDependencies(tree, options));
  noteValidationPath(options);

  if (options.isNewProject && !options.specProvided && !tree.exists(options.spec)) {
    tree.write(options.spec, readFileSync(SAMPLE_SPEC, 'utf8'));
  }
  tree.write(configPath, orvalConfigSource(options, projectTsconfig(tree, options.projectRoot)));

  if (!rawOptions.skipFormat) await formatFiles(tree);
  tasks.push(
    generateOnce(projectNameOf(tree, options, rawOptions), registeredTargetName(tree), rawOptions.skipGenerate ?? false),
  );
  return runTasksInSerial(...tasks);
}

export default apiGenerator;
