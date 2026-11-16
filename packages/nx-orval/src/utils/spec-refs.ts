import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

/** Spec formats Orval can follow `$ref`s into. */
const SPEC_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

/** `$ref` depth followed from a spec; bounds the work on pathological graphs. */
export const MAX_REF_DEPTH = 10;

/** `$ref` values in YAML (`$ref: ./a.yaml#/X`) and JSON (`"$ref": "./a.json#/X"`). */
const REF_VALUE = /["']?\$ref["']?\s*:\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"',}\]]+))/g;

const toPosix = (path: string): string => path.split('\\').join('/');

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** A `$ref` that points at another local file (not `#/...`, a URL or an absolute path). */
const localRefFile = (value: string): string | undefined => {
  const file = value.split('#')[0].trim();
  if (!file || file.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(file)) return undefined;
  return file;
};

const refsOf = (source: string): string[] =>
  [...source.matchAll(REF_VALUE)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .map(localRefFile)
    .filter((file): file is string => file !== undefined);

const isSpecFile = (file: string): boolean =>
  (SPEC_EXTENSIONS as readonly string[]).includes(extname(file).toLowerCase());

/**
 * Files a local spec pulls in through relative `$ref`s, as workspace-relative
 * posix paths (the specs themselves excluded, sorted). Refs that leave the
 * workspace, point at URLs or at missing files are ignored.
 *
 * A folder glob cannot express this for a spec in the workspace root or for a
 * `$ref: ../shared/errors.yaml` that leaves the spec's folder.
 */
export const specRefFiles = (
  workspaceRoot: string,
  specs: readonly string[],
  maxDepth: number = MAX_REF_DEPTH,
): string[] => {
  const root = resolve(workspaceRoot);
  const starts = specs.map((spec) => join(root, spec));
  const visited = new Set<string>(starts);

  const visit = (file: string, depth: number): void => {
    if (depth >= maxDepth) return;
    refsOf(readText(file))
      .map((ref) => resolve(dirname(file), ref))
      .filter((resolved) => isSpecFile(resolved) && isFile(resolved))
      .forEach((resolved) => {
        // Mark before descending so reference cycles terminate.
        if (visited.has(resolved)) return;
        visited.add(resolved);
        visit(resolved, depth + 1);
      });
  };

  starts.forEach((start) => visit(start, 0));

  return [...visited]
    .filter((file) => !starts.includes(file))
    .map((file) => toPosix(relative(root, file)))
    .filter((file) => file !== '..' && !file.startsWith('../'))
    .sort();
};
