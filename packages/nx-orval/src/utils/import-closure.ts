import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

/** Extensions a config module can have; these are parsed for further imports. */
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

/** Extensions tried, in order, for an extensionless relative specifier. */
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.json'] as const;

/** ESM TypeScript writes `./x.js` for a file that is `./x.ts` on disk. */
const RUNTIME_TO_SOURCE: Readonly<Record<string, string>> = {
  '.js': '.ts',
  '.mjs': '.mts',
  '.cjs': '.cts',
};

/** Import depth followed from the config; bounds the work on pathological graphs. */
export const MAX_IMPORT_DEPTH = 10;

/**
 * Relative specifiers in `import`, `export ... from`, dynamic `import()` and
 * `require()`. Comments and strings can produce false positives, which only
 * add an extra tracked file when the path happens to exist.
 */
const RELATIVE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}(?:\/[^'"\n]*)?)['"]/g;

const toPosix = (path: string): string => path.split('\\').join('/');

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Paths a relative specifier can point at, most specific first. */
const candidatesFor = (base: string): string[] => {
  const extension = extname(base);
  const swapped = RUNTIME_TO_SOURCE[extension];
  return [
    base,
    ...(swapped ? [`${base.slice(0, -extension.length)}${swapped}`] : []),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
};

const resolveSpecifier = (fromFile: string, specifier: string): string | undefined =>
  candidatesFor(resolve(dirname(fromFile), specifier)).find(isFile);

const specifiersOf = (source: string): string[] =>
  [...source.matchAll(RELATIVE_SPECIFIER)].map((match) => match[1]);

const readSource = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const isParsable = (file: string): boolean =>
  (SOURCE_EXTENSIONS as readonly string[]).includes(extname(file));

/**
 * Every local file the Orval config reaches through relative imports, as
 * workspace-relative posix paths (the config itself excluded, sorted).
 *
 * Shared base configs and constants live outside the config file, yet decide
 * its spec and output paths, so they have to feed both the graph cache key and
 * the task inputs. Package imports (`dotenv/config`, workspace aliases) are not
 * followed, and `node_modules` is never entered.
 */
export const importClosure = (
  workspaceRoot: string,
  configFile: string,
  maxDepth: number = MAX_IMPORT_DEPTH,
): string[] => {
  const root = resolve(workspaceRoot);
  const configPath = join(root, configFile);
  const visited = new Set<string>([configPath]);

  const visit = (file: string, depth: number): void => {
    if (depth >= maxDepth || !isParsable(file)) return;
    specifiersOf(readSource(file))
      .map((specifier) => resolveSpecifier(file, specifier))
      .filter((resolved): resolved is string => resolved !== undefined)
      .filter((resolved) => !resolved.split(/[\\/]/).includes('node_modules'))
      .filter((resolved) => !visited.has(resolved))
      .forEach((resolved) => {
        // Mark before descending so import cycles terminate.
        if (visited.has(resolved)) return;
        visited.add(resolved);
        visit(resolved, depth + 1);
      });
  };

  visit(configPath, 0);
  visited.delete(configPath);

  return [...visited].map((file) => toPosix(relative(root, file))).sort();
};
