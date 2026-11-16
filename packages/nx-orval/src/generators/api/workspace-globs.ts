import { type Tree, readJson } from '@nx/devkit';

/** Folders that hold deployable code, so a package-manager glob over them is not where libraries go. */
const NON_LIBRARY_FOLDERS = new Set(['apps', 'tools', 'e2e']);

/** Used when the workspace declares no package-manager workspaces. */
export const FALLBACK_LIBRARY_ROOT = 'libs';

interface PackageJsonWorkspaces {
  readonly workspaces?: unknown[] | { readonly packages?: unknown[] };
}

const isString = (value: unknown): value is string => typeof value === 'string';

const normalizeGlob = (glob: string): string =>
  glob
    .trim()
    .replace(/^(!?)\.\//, '$1')
    .replace(/\/+$/, '');

const packageJsonGlobs = (tree: Tree): string[] => {
  if (!tree.exists('package.json')) return [];
  const { workspaces } = readJson<PackageJsonWorkspaces>(tree, 'package.json');
  const globs = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  return Array.isArray(globs) ? globs.filter(isString) : [];
};

/** One list item of a pnpm-workspace.yaml `packages:` block, with quotes and trailing comment removed. */
const YAML_LIST_ITEM = /^\s*-\s*(?:'([^']*)'|"([^"]*)"|([^#\s][^#]*?))\s*(?:#.*)?$/;

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The `packages:` globs of a pnpm-workspace.yaml, in block-list or inline-list form. */
export const parsePnpmPackages = (source: string): string[] => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const inline = /^packages\s*:\s*\[(.*)\]\s*(?:#.*)?$/.exec(lines[start]);
  if (inline) {
    return inline[1].split(',').map(unquote).filter((glob) => glob !== '');
  }
  const body = lines.slice(start + 1).filter((line) => !/^\s*(?:#.*)?$/.test(line));
  const end = body.findIndex((line) => !YAML_LIST_ITEM.test(line));
  return (end === -1 ? body : body.slice(0, end)).flatMap((line) => {
    const match = YAML_LIST_ITEM.exec(line);
    const glob = match?.[1] ?? match?.[2] ?? match?.[3];
    return glob === undefined ? [] : [glob];
  });
};

const pnpmGlobs = (tree: Tree): string[] =>
  tree.exists('pnpm-workspace.yaml')
    ? parsePnpmPackages(tree.read('pnpm-workspace.yaml', 'utf8') ?? '')
    : [];

/**
 * The package-manager workspaces globs of the workspace (package.json `workspaces`,
 * pnpm-workspace.yaml `packages`), or undefined when it declares none.
 */
export const readWorkspaceGlobs = (tree: Tree): readonly string[] | undefined => {
  const globs = [...packageJsonGlobs(tree), ...pnpmGlobs(tree)].map(normalizeGlob).filter(Boolean);
  return globs.length > 0 ? globs : undefined;
};

/** `packages/*` and `packages/**` give `packages`; globs with wildcards before the last segment give nothing. */
const globFolder = (glob: string): string | undefined => {
  const match = /^(.+)\/\*{1,2}$/.exec(glob);
  return match && !/[*?{}[\]!]/.test(match[1]) ? match[1] : undefined;
};

/**
 * Where libraries go by default: the first workspaces glob that lists a folder of
 * packages (so `packages/*` gives `packages`), skipping app and tooling folders.
 * Falls back to `libs` when the workspace declares no such glob.
 */
export const defaultLibraryRoot = (globs: readonly string[] | undefined): string =>
  (globs ?? [])
    .map(globFolder)
    .find(
      (folder) =>
        folder !== undefined && !folder.split('/').some((segment) => NON_LIBRARY_FOLDERS.has(segment)),
    ) ?? FALLBACK_LIBRARY_ROOT;

const WILDCARDS: Readonly<Record<string, string>> = {
  '**/': '(?:.+/)?',
  '**': '.+',
  '*': '[^/]+',
  '?': '[^/]',
};

/** Glob to RegExp for workspaces globs: `*` stays inside a folder, `**` crosses folders. */
const globToRegExp = (glob: string): RegExp => {
  const source = glob
    .replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, (token) => WILDCARDS[token] ?? token)
    .replace(/\{([^}]*)\}/g, (_match, alternatives: string) => `(?:${alternatives.split(',').join('|')})`);
  return new RegExp(`^${source}$`);
};

/** True when a workspaces glob list (including `!` exclusions) makes the package manager link `root`. */
export const isCoveredByGlobs = (root: string, globs: readonly string[]): boolean => {
  const matches = (glob: string): boolean => globToRegExp(glob).test(root);
  const included = globs.filter((glob) => !glob.startsWith('!')).some(matches);
  const excluded = globs.filter((glob) => glob.startsWith('!')).some((glob) => matches(glob.slice(1)));
  return included && !excluded;
};
