import {
  type GeneratorCallback,
  type Tree,
  addDependenciesToPackageJson,
  formatFiles,
  logger,
  readNxJson,
  updateNxJson,
  visitNotIgnoredFiles,
} from '@nx/devkit';
import { posix } from 'node:path';
import { ORVAL_CONFIG_NAMES } from '../../utils/orval-config';
import type { InitGeneratorSchema } from './schema';

export const PLUGIN_NAME = 'nx-orval';
export const ORVAL_VERSION = '^8.48.0';

const DEFAULT_TARGET_NAME = 'orval';

type PluginEntry = string | { plugin: string };

const hasPlugin = (plugins: readonly PluginEntry[]): boolean =>
  plugins.some((entry) => (typeof entry === 'string' ? entry : entry.plugin) === PLUGIN_NAME);

const noop: GeneratorCallback = () => undefined;

/**
 * Registers the plugin in nx.json and adds Orval to package.json, without reporting or formatting.
 * An existing plugin entry is left as it is, so reruns (`nx add` on an adopted workspace) change nothing.
 */
export const registerOrval = (tree: Tree, options: InitGeneratorSchema): GeneratorCallback => {
  const nxJson = readNxJson(tree) ?? {};
  const plugins = nxJson.plugins ?? [];
  if (!hasPlugin(plugins)) {
    updateNxJson(tree, {
      ...nxJson,
      plugins: [
        ...plugins,
        { plugin: PLUGIN_NAME, options: { targetName: options.targetName ?? DEFAULT_TARGET_NAME } },
      ],
    });
  }
  return options.skipPackageJson
    ? noop
    : addDependenciesToPackageJson(
        tree,
        {},
        { orval: ORVAL_VERSION },
        undefined,
        options.keepExistingVersions ?? true,
      );
};

interface PackageJsonScripts {
  readonly scripts?: Readonly<Record<string, unknown>>;
}

/** A script that runs the Orval CLI itself; `nx run-many -t orval` style scripts already go through Nx. */
const runsOrvalCli = (command: unknown): boolean =>
  typeof command === 'string' && /(?:^|[\s;&|])orval(?:\s|$)/.test(command) && !/\bnx\b/.test(command);

const orvalScripts = (tree: Tree, packageJsonPath: string): string[] => {
  try {
    const { scripts } = JSON.parse(tree.read(packageJsonPath, 'utf8') ?? '{}') as PackageJsonScripts;
    return Object.entries(scripts ?? {})
      .filter(([, command]) => runsOrvalCli(command))
      .map(([name]) => name);
  } catch {
    return [];
  }
};

/** What the workspace already has: Orval configs that get an inferred target, scripts that now duplicate it. */
const reportExistingSetup = (tree: Tree, targetName: string): void => {
  const configs: string[] = [];
  const scripts: string[] = [];
  visitNotIgnoredFiles(tree, '', (path) => {
    const file = posix.basename(path);
    if (ORVAL_CONFIG_NAMES.includes(file)) configs.push(path);
    if (file === 'package.json') {
      scripts.push(...orvalScripts(tree, path).map((name) => `"${name}" in ${path}`));
    }
  });
  if (configs.length > 0) {
    logger.info(
      [
        `nx-orval: found ${configs.length} Orval config${configs.length === 1 ? '' : 's'}; each project with one gets an inferred "${targetName}" target:`,
        ...configs.map((path) => `  ${path}`),
        `Run them all with: nx run-many -t ${targetName}`,
      ].join('\n'),
    );
  }
  if (scripts.length > 0) {
    logger.info(
      [
        `nx-orval: these package.json scripts run Orval directly. The inferred "${targetName}" target adds caching, so they can go once you switch:`,
        ...scripts.map((script) => `  ${script}`),
      ].join('\n'),
    );
  }
};

/** The target name of the registered plugin entry, else the fallback. */
export const registeredTargetName = (tree: Tree, fallback: string = DEFAULT_TARGET_NAME): string => {
  const entry = (readNxJson(tree)?.plugins ?? []).find(
    (plugin) => typeof plugin !== 'string' && plugin.plugin === PLUGIN_NAME,
  );
  const options = typeof entry === 'object' ? (entry.options as { targetName?: unknown } | undefined) : undefined;
  return typeof options?.targetName === 'string' ? options.targetName : fallback;
};

/** Registers the inferred-task plugin in nx.json, adds Orval to the workspace and reports what it found. */
export async function initGenerator(
  tree: Tree,
  options: InitGeneratorSchema,
): Promise<GeneratorCallback> {
  const install = registerOrval(tree, options);

  try {
    reportExistingSetup(tree, registeredTargetName(tree, options.targetName ?? DEFAULT_TARGET_NAME));
  } catch {
    // The report is a courtesy; a tree that cannot be walked must not fail the setup.
  }

  if (!options.skipFormat) await formatFiles(tree);
  return install;
}

export default initGenerator;
