import { type Tree, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  defaultLibraryRoot,
  isCoveredByGlobs,
  parsePnpmPackages,
  readWorkspaceGlobs,
} from './workspace-globs';

describe('parsePnpmPackages', () => {
  it('reads a block list with quotes, comments and blank lines', () => {
    const source = [
      "# monorepo",
      'packages:',
      "  - 'apps/*'",
      '',
      '  - "packages/*" # libraries',
      '  - tools/*',
      "  - '!**/test/**'",
      'catalog:',
      "  - 'not-a-package'",
      '',
    ].join('\n');

    expect(parsePnpmPackages(source)).toEqual(['apps/*', 'packages/*', 'tools/*', '!**/test/**']);
  });

  it('reads an unindented block list and CRLF line endings', () => {
    expect(parsePnpmPackages('packages:\r\n- libs/*\r\n- apps/*\r\n')).toEqual(['libs/*', 'apps/*']);
  });

  it('reads an inline list', () => {
    expect(parsePnpmPackages("packages: ['libs/*', \"apps/*\"]")).toEqual(['libs/*', 'apps/*']);
  });

  it('returns nothing without a packages key', () => {
    expect(parsePnpmPackages('catalog:\n  - a\n')).toEqual([]);
  });
});

describe('readWorkspaceGlobs', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('is undefined when the workspace declares no workspaces', () => {
    expect(readWorkspaceGlobs(tree)).toBeUndefined();
  });

  it('merges package.json workspaces and pnpm-workspace.yaml, normalised', () => {
    updateJson(tree, 'package.json', (json) => ({ ...json, workspaces: ['./packages/*/'] }));
    tree.write('pnpm-workspace.yaml', 'packages:\n  - libs/*\n');

    expect(readWorkspaceGlobs(tree)).toEqual(['packages/*', 'libs/*']);
  });

  it('treats an empty workspaces list as no workspaces', () => {
    updateJson(tree, 'package.json', (json) => ({ ...json, workspaces: [] }));

    expect(readWorkspaceGlobs(tree)).toBeUndefined();
  });
});

describe('defaultLibraryRoot', () => {
  it.each([
    [['packages/*'], 'packages'],
    [['packages/**'], 'packages'],
    [['apps/*', 'libs/*'], 'libs'],
    [['apps/*', 'tools/*', 'e2e/*', 'clients/*'], 'clients'],
    [['libs/shared/*'], 'libs/shared'],
    [['!packages/legacy/*', 'packages/*'], 'packages'],
    [['packages/*/src', '*'], 'libs'],
    [['apps/*'], 'libs'],
    [undefined, 'libs'],
  ])('%j gives %s', (globs, expected) => {
    expect(defaultLibraryRoot(globs)).toBe(expected);
  });
});

describe('isCoveredByGlobs', () => {
  it.each([
    ['packages/petstore', ['packages/*'], true],
    ['packages/clients/petstore', ['packages/*'], false],
    ['packages/clients/petstore', ['packages/**'], true],
    ['libs/petstore', ['packages/*'], false],
    ['libs/petstore', ['apps/*', 'libs/*'], true],
    ['packages/petstore', ['packages/*', '!packages/petstore'], false],
    ['packages/a.b', ['packages/*'], true],
    ['clients/petstore', ['{clients,packages}/*'], true],
    ['services/petstore', ['{clients,packages}/*'], false],
    ['apps/web/api', ['**/api'], true],
    ['api', ['**/api'], true],
    ['packagesX/petstore', ['packages/*'], false],
  ])('%s against %j is %s', (root, globs, expected) => {
    expect(isCoveredByGlobs(root, globs)).toBe(expected);
  });
});
