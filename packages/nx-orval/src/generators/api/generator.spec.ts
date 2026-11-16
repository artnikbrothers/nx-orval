import { execSync } from 'node:child_process';
import {
  type Tree,
  addProjectConfiguration,
  logger,
  readJson,
  readProjectConfiguration,
  updateJson,
  workspaceRoot,
  writeJson,
} from '@nx/devkit';
import { join } from 'node:path';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { apiGenerator } from './generator';

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execSync: jest.fn(),
}));

const execSyncMock = jest.mocked(execSync);

const useWorkspaces = (tree: Tree): void => {
  updateJson(tree, 'package.json', (json) => ({ ...json, workspaces: ['libs/*', 'apps/**'] }));
  writeJson(tree, 'tsconfig.base.json', {
    compilerOptions: { composite: true, declaration: true },
  });
  writeJson(tree, 'tsconfig.json', { extends: './tsconfig.base.json', files: [], references: [] });
};

describe('api generator', () => {
  let tree: Tree;
  const initCwd = process.env.INIT_CWD;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    process.env.INIT_CWD = workspaceRoot;
  });

  afterEach(() => {
    if (initCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = initCwd;
    jest.restoreAllMocks();
    execSyncMock.mockReset();
  });

  it('creates a library with a sample spec, Orval config and path alias', async () => {
    await apiGenerator(tree, { name: 'petstore', client: 'react-query' });

    expect(readProjectConfiguration(tree, 'petstore').root).toBe('libs/petstore');
    expect(tree.exists('libs/petstore/openapi.yaml')).toBe(true);
    const config = tree.read('libs/petstore/orval.config.ts', 'utf8');
    expect(config).toContain('target: "./openapi.yaml"');
    expect(config).toContain('client: "react-query"');
    expect(config).toContain("workspace: './src/generated/client'");
    expect(config).toContain("mode: 'tags'");
    expect(config).toContain("operationSchemas: './models/operations'");
    expect(config).toContain('header,');
    expect(tree.read('libs/petstore/src/index.ts', 'utf8')).toBe(
      "export * from './generated/client';\n",
    );
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@proj/petstore']).toEqual([
      './libs/petstore/src/index.ts',
    ]);
    expect(tree.exists('libs/petstore/src/lib')).toBe(false);
  });

  it('creates a workspace package when the workspace links projects with workspaces', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      workspaces: ['libs/*'],
    }));
    writeJson(tree, 'tsconfig.base.json', {
      compilerOptions: { composite: true, declaration: true },
    });
    writeJson(tree, 'tsconfig.json', {
      extends: './tsconfig.base.json',
      files: [],
      references: [],
    });
    await apiGenerator(tree, { name: 'first', skipFormat: true });
    const compactNxJson = JSON.stringify(readJson(tree, 'nx.json'));
    tree.write('nx.json', compactNxJson);

    await apiGenerator(tree, {
      name: 'petstore',
      tags: 'type:data-access',
      skipFormat: true,
    });

    expect(tree.read('nx.json', 'utf8')).toBe(compactNxJson);

    const packageJson = readJson(tree, 'libs/petstore/package.json');
    expect(packageJson.name).toBe('@proj/petstore');
    expect(packageJson.nx.name).toBeUndefined();
    expect(readProjectConfiguration(tree, '@proj/petstore').tags).toEqual(['type:data-access']);
    expect(tree.exists('libs/petstore/project.json')).toBe(false);
    expect(readJson(tree, 'libs/petstore/tsconfig.lib.json').compilerOptions).toMatchObject({
      module: 'esnext',
      moduleResolution: 'bundler',
    });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toBeUndefined();
    expect(readJson(tree, 'tsconfig.json').references).toContainEqual({
      path: './libs/petstore',
    });
    expect(tree.exists('libs/petstore/orval.config.ts')).toBe(true);
  });

  it('writes a README with the import path and the regenerate command', async () => {
    useWorkspaces(tree);
    await apiGenerator(tree, { name: 'petstore', spec: 'https://example.com/openapi.json' });

    const readme = tree.read('libs/petstore/README.md', 'utf8');
    expect(readme).toContain('# @proj/petstore');
    expect(readme).toContain('npx nx run @proj/petstore:orval');
    expect(readme).toContain('https://example.com/openapi.json');
    expect(readme).toContain("from '@proj/petstore'");
  });

  it('leaves no empty nx field when no tags are given', async () => {
    useWorkspaces(tree);
    await apiGenerator(tree, { name: 'petstore' });
    expect(readJson(tree, 'libs/petstore/package.json').nx).toBeUndefined();
  });

  it('keeps comments in root JSON files that did not change', async () => {
    useWorkspaces(tree);
    await apiGenerator(tree, { name: 'first', skipFormat: true });
    const withComment = `// keep me\n${tree.read('nx.json', 'utf8')}`;
    tree.write('nx.json', withComment);

    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    expect(tree.read('nx.json', 'utf8')).toBe(withComment);
  });

  it('refuses to create a library in a folder that already has files', async () => {
    tree.write('libs/petstore/src/lib/helpers.ts', 'export const keep = 1;');
    await expect(apiGenerator(tree, { name: 'petstore' })).rejects.toThrow('already exists');
    expect(tree.read('libs/petstore/src/lib/helpers.ts', 'utf8')).toBe('export const keep = 1;');
  });

  it('creates the library and the Orval config in the same folder when run from a subfolder', async () => {
    process.env.INIT_CWD = join(workspaceRoot, 'apps', 'web');

    await apiGenerator(tree, { name: 'petstore' });
    await apiGenerator(tree, { name: 'local', directory: 'clients/local' });

    expect(readProjectConfiguration(tree, 'petstore').root).toBe('libs/petstore');
    expect(tree.exists('libs/petstore/orval.config.ts')).toBe(true);
    expect(tree.exists('apps/web/libs')).toBe(false);
    expect(readProjectConfiguration(tree, 'local').root).toBe('apps/web/clients/local');
    expect(tree.exists('apps/web/clients/local/orval.config.ts')).toBe(true);
  });

  it('keeps generated code out of lint', async () => {
    await apiGenerator(tree, { name: 'petstore', linter: 'eslint' });
    expect(tree.read('libs/petstore/eslint.config.mjs', 'utf8')).toContain(
      "ignores: ['**/src/generated/**']",
    );
  });

  it('warns about library-only options used with --project', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    addProjectConfiguration(tree, 'web', { root: 'apps/web' });
    tree.write('apps/web/openapi.yaml', 'openapi: 3.0.0');
    await apiGenerator(tree, { name: 'web-api', project: 'web', tags: 'x' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--tags'));
  });

  it('does not warn when no library-only option is passed with --project', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    addProjectConfiguration(tree, 'web', { root: 'apps/web' });
    tree.write('apps/web/openapi.yaml', 'openapi: 3.0.0');
    await apiGenerator(tree, { name: 'web-api', project: 'web' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('points the config at an existing spec in another project', async () => {
    tree.write('apps/backend/openapi.json', '{}');
    await apiGenerator(tree, {
      name: 'backend-client',
      spec: 'apps/backend/openapi.json',
    });

    expect(tree.read('libs/backend-client/orval.config.ts', 'utf8')).toContain(
      'target: "../../apps/backend/openapi.json"',
    );
    expect(tree.exists('libs/backend-client/openapi.yaml')).toBe(false);
  });

  it('keeps remote specs as URLs', async () => {
    await apiGenerator(tree, {
      name: 'remote',
      spec: 'https://example.com/openapi.json',
    });
    expect(tree.read('libs/remote/orval.config.ts', 'utf8')).toContain(
      'target: "https://example.com/openapi.json"',
    );
  });

  it('adds a config to an existing project without overwriting its spec', async () => {
    addProjectConfiguration(tree, 'web', { root: 'apps/web' });
    tree.write('apps/web/openapi.yaml', 'openapi: 3.0.0');
    await apiGenerator(tree, { name: 'web-api', project: 'web' });

    expect(tree.read('apps/web/openapi.yaml', 'utf8')).toBe('openapi: 3.0.0');
    expect(tree.exists('apps/web/orval.config.ts')).toBe(true);
    expect(tree.exists('libs/web-api')).toBe(false);
  });

  it('reuses an existing spec and refuses a second config of any extension', async () => {
    addProjectConfiguration(tree, 'web', { root: 'apps/web' });
    tree.write('apps/web/openapi.json', '{}');
    await apiGenerator(tree, { name: 'web-api', project: 'web' });
    expect(tree.read('apps/web/orval.config.ts', 'utf8')).toContain('target: "./openapi.json"');
    expect(tree.exists('apps/web/openapi.yaml')).toBe(false);

    addProjectConfiguration(tree, 'admin', { root: 'apps/admin' });
    tree.write('apps/admin/orval.config.js', 'module.exports = {};');
    await expect(apiGenerator(tree, { name: 'admin-api', project: 'admin' })).rejects.toThrow(
      'orval.config.js already exists',
    );
  });

  it('escapes quotes in user input', async () => {
    tree.write("apps/it's/openapi.yaml", 'openapi: 3.0.0');
    await apiGenerator(tree, {
      name: 'quoted',
      spec: "apps/it's/openapi.yaml",
    });
    expect(tree.read('libs/quoted/orval.config.ts', 'utf8')).toContain(
      `target: "../../apps/it's/openapi.yaml"`,
    );
  });

  it('rejects a missing local spec', async () => {
    await expect(apiGenerator(tree, { name: 'x', spec: 'nope.yaml' })).rejects.toThrow(
      'does not exist',
    );
  });

  it('refuses to overwrite an existing Orval config', async () => {
    await apiGenerator(tree, { name: 'petstore' });
    await expect(apiGenerator(tree, { name: 'again', project: 'petstore' })).rejects.toThrow(
      'already exists',
    );
  });

  it('adds a validation entry in its own folder and namespace', async () => {
    await apiGenerator(tree, { name: 'petstore', validation: 'valibot', skipFormat: true });

    const config = tree.read('libs/petstore/orval.config.ts', 'utf8');
    expect(config).toContain('"petstore-valibot": {');
    expect(config).toContain("workspace: './src/generated/valibot'");
    expect(config).toContain('client: "valibot"');
    expect(tree.read('libs/petstore/src/index.ts', 'utf8')).toContain(
      "export * as valibot from './generated/valibot';",
    );
    expect(tree.read('libs/petstore/README.md', 'utf8')).toContain('src/generated/valibot/');
  });

  it('skips a validation entry that the client already generates', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await apiGenerator(tree, { name: 'petstore', client: 'zod', validation: 'zod', skipFormat: true });

    const config = tree.read('libs/petstore/orval.config.ts', 'utf8');
    expect(config).not.toContain('"petstore-zod"');
    expect(config).not.toContain('operationSchemas');
    expect(config).not.toContain('mock:');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already generates zod'));
  });

  it('uses the formatter the workspace already has', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: { ...json.devDependencies, '@biomejs/biome': '^2.0.0', prettier: '^3.0.0' },
    }));
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    expect(tree.read('libs/petstore/orval.config.ts', 'utf8')).toContain('formatter: "biome"');
  });

  it('writes no formatter when the workspace has none', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: Object.fromEntries(
        Object.entries(json.devDependencies ?? {}).filter(([name]) => name !== 'prettier'),
      ),
    }));
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    expect(tree.read('libs/petstore/orval.config.ts', 'utf8')).not.toContain('formatter');
  });

  it('points Orval at the library tsconfig and passes the http client', async () => {
    await apiGenerator(tree, {
      name: 'petstore',
      client: 'react-query',
      httpClient: 'axios',
      skipFormat: true,
    });

    const config = tree.read('libs/petstore/orval.config.ts', 'utf8');
    expect(config).toContain('tsconfig: "./tsconfig.lib.json"');
    expect(config).toContain('httpClient: "axios"');
  });

  it('refuses to write an Orval 8 config into an Orval 7 workspace', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: { ...json.devDependencies, orval: '^7.10.0' },
    }));

    await expect(apiGenerator(tree, { name: 'petstore', skipFormat: true })).rejects.toThrow(
      /Orval 8 config/,
    );
  });

  it('switches to bundler resolution when nodenext is inherited from the base tsconfig', async () => {
    useWorkspaces(tree);
    updateJson(tree, 'tsconfig.base.json', (json) => ({
      ...json,
      compilerOptions: { ...json.compilerOptions, module: 'nodenext', moduleResolution: 'nodenext' },
    }));
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    const { compilerOptions } = readJson(tree, 'libs/petstore/tsconfig.lib.json');
    expect(compilerOptions.moduleResolution).toBe('bundler');
    expect(compilerOptions.module).toBe('esnext');
  });

  it('switches to bundler resolution for node20 modules inherited from the base tsconfig', async () => {
    useWorkspaces(tree);
    updateJson(tree, 'tsconfig.base.json', (json) => ({
      ...json,
      compilerOptions: { ...json.compilerOptions, module: 'node20' },
    }));
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    const { compilerOptions } = readJson(tree, 'libs/petstore/tsconfig.lib.json');
    expect(compilerOptions.moduleResolution).toBe('bundler');
    expect(compilerOptions.module).toBe('esnext');
  });

  it('adds the packages the generated code imports, keeping existing versions', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      dependencies: { ...json.dependencies, axios: '1.6.0' },
    }));
    await apiGenerator(tree, {
      name: 'petstore',
      client: 'react-query',
      httpClient: 'axios',
      validation: 'valibot',
      mock: true,
      skipFormat: true,
    });

    const { dependencies, devDependencies } = readJson(tree, 'package.json');
    expect(dependencies['@tanstack/react-query']).toBeDefined();
    expect(dependencies.valibot).toBeDefined();
    expect(dependencies.axios).toBe('1.6.0');
    expect(devDependencies.msw).toBeDefined();
  });

  it('drops options that do not apply to the client, with a warning', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await apiGenerator(tree, {
      name: 'petstore',
      client: 'hono',
      httpClient: 'axios',
      skipFormat: true,
    });
    await apiGenerator(tree, { name: 'schemas', client: 'zod', mock: true, skipFormat: true });

    expect(tree.read('libs/petstore/orval.config.ts', 'utf8')).not.toContain('httpClient');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--httpClient applies to'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--mock is ignored'));
  });

  it('accepts an Orval range that allows 8 among older alternatives', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: { ...json.devDependencies, orval: '^7.10.0 || ^8.48.0' },
    }));

    await expect(apiGenerator(tree, { name: 'petstore', skipFormat: true })).resolves.toBeDefined();
  });

  it('names the registered target in the README', async () => {
    updateJson(tree, 'nx.json', (json) => ({
      ...json,
      plugins: [{ plugin: 'nx-orval', options: { targetName: 'codegen' } }],
    }));
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    expect(tree.read('libs/petstore/README.md', 'utf8')).toContain(':codegen');
  });

  describe('library location', () => {
    const useWorkspaceGlobs = (globs: string[]): void =>
      updateJson(tree, 'package.json', (json) => ({ ...json, workspaces: globs }));

    it('follows the package manager workspaces folder', async () => {
      useWorkspaceGlobs(['packages/*']);
      await apiGenerator(tree, { name: 'petstore', skipFormat: true });

      expect(tree.exists('packages/petstore/orval.config.ts')).toBe(true);
      expect(tree.exists('libs/petstore')).toBe(false);
    });

    it('reads the object form of workspaces', async () => {
      updateJson(tree, 'package.json', (json) => ({
        ...json,
        workspaces: { packages: ['apps/*', 'packages/**'] },
      }));
      await apiGenerator(tree, { name: 'petstore', skipFormat: true });

      expect(tree.exists('packages/petstore/orval.config.ts')).toBe(true);
    });

    it('reads pnpm-workspace.yaml', async () => {
      tree.write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'clients/*'\n");
      await apiGenerator(tree, { name: 'petstore', skipFormat: true });

      expect(tree.exists('clients/petstore/orval.config.ts')).toBe(true);
    });

    it('skips app folders when picking the default', async () => {
      useWorkspaceGlobs(['apps/*', 'tools/*', 'libs/*']);
      await apiGenerator(tree, { name: 'petstore', skipFormat: true });

      expect(tree.exists('libs/petstore/orval.config.ts')).toBe(true);
    });

    it('keeps an explicit directory that a workspaces glob covers', async () => {
      useWorkspaceGlobs(['packages/*', 'libs/**']);
      await apiGenerator(tree, { name: 'petstore', directory: 'libs/clients/petstore', skipFormat: true });

      expect(tree.exists('libs/clients/petstore/orval.config.ts')).toBe(true);
    });

    it('refuses a directory the workspaces globs do not cover', async () => {
      useWorkspaceGlobs(['packages/*']);

      await expect(
        apiGenerator(tree, { name: 'petstore', directory: 'libs/petstore', skipFormat: true }),
      ).rejects.toThrow('libs/petstore is not covered by the workspaces globs [packages/*]');
      expect(tree.exists('libs/petstore')).toBe(false);
    });

    it('refuses the libs fallback when the globs only list app folders', async () => {
      useWorkspaceGlobs(['apps/*']);

      await expect(apiGenerator(tree, { name: 'petstore', skipFormat: true })).rejects.toThrow(
        'not covered by the workspaces globs [apps/*]',
      );
    });

    it('does not apply the workspaces check to an existing project', async () => {
      useWorkspaceGlobs(['packages/*']);
      addProjectConfiguration(tree, 'web', { root: 'apps/web' });
      tree.write('apps/web/openapi.yaml', 'openapi: 3.0.0');

      await apiGenerator(tree, { project: 'web', skipFormat: true });

      expect(tree.exists('apps/web/orval.config.ts')).toBe(true);
    });
  });

  describe('options for an existing project', () => {
    beforeEach(() => {
      addProjectConfiguration(tree, 'web', { root: 'apps/web' });
    });

    it('names the Orval entry after the project when no name is given', async () => {
      tree.write('apps/web/openapi.yaml', 'openapi: 3.0.0');
      await apiGenerator(tree, { project: 'web', skipFormat: true });

      expect(tree.read('apps/web/orval.config.ts', 'utf8')).toContain('"web": {');
    });

    it('uses the last segment of a scoped project name', async () => {
      addProjectConfiguration(tree, '@proj/admin', { root: 'apps/admin' });
      tree.write('apps/admin/openapi.yaml', 'openapi: 3.0.0');
      await apiGenerator(tree, { project: '@proj/admin', skipFormat: true });

      expect(tree.read('apps/admin/orval.config.ts', 'utf8')).toContain('"admin": {');
    });

    it('asks for a name when there is neither a name nor a project', async () => {
      await expect(apiGenerator(tree, { skipFormat: true })).rejects.toThrow('Name the API');
    });

    it('does not write a sample spec into an existing project', async () => {
      await expect(apiGenerator(tree, { project: 'web', skipFormat: true })).rejects.toThrow(
        'No OpenAPI spec found in apps/web. Pass --spec',
      );
      expect(tree.exists('apps/web/openapi.yaml')).toBe(false);
    });

    it('treats an empty spec answer as no spec', async () => {
      tree.write('apps/web/openapi.json', '{}');
      await apiGenerator(tree, { project: 'web', spec: '  ', skipFormat: true });

      expect(tree.read('apps/web/orval.config.ts', 'utf8')).toContain('target: "./openapi.json"');
    });

    it('reports an existing Orval config before a missing spec', async () => {
      tree.write('apps/web/orval.config.ts', 'export default {};');
      await expect(apiGenerator(tree, { project: 'web', skipFormat: true })).rejects.toThrow(
        'orval.config.ts already exists',
      );
    });
  });

  it('starts a new library from the sample when the spec answer is empty', async () => {
    await apiGenerator(tree, { name: 'petstore', spec: '', skipFormat: true });

    expect(tree.exists('libs/petstore/openapi.yaml')).toBe(true);
    expect(tree.read('libs/petstore/orval.config.ts', 'utf8')).toContain('target: "./openapi.yaml"');
  });

  it('accepts underscores in the name', async () => {
    await apiGenerator(tree, { name: 'pet_store', skipFormat: true });

    expect(tree.exists('libs/pet_store/orval.config.ts')).toBe(true);
  });

  it('follows the linter the workspace already uses when none is given', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: { ...json.devDependencies, eslint: '^9.0.0' },
    }));
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    expect(tree.exists('libs/petstore/eslint.config.mjs')).toBe(true);
  });

  it('adds no linter to a workspace without one', async () => {
    await apiGenerator(tree, { name: 'petstore', skipFormat: true });

    expect(tree.exists('libs/petstore/eslint.config.mjs')).toBe(false);
  });

  describe('first generation', () => {
    const generationCalls = (): unknown[][] =>
      execSyncMock.mock.calls.filter(([command]) => /\bnx run\b/.test(String(command)));

    it('runs the Orval target once after the install', async () => {
      const done = await apiGenerator(tree, { name: 'petstore', skipFormat: true });
      expect(generationCalls()).toHaveLength(0);

      await done();

      expect(generationCalls()).toEqual([
        [expect.stringMatching(/ nx run petstore:orval$/), { cwd: workspaceRoot, stdio: 'inherit' }],
      ]);
      expect(execSyncMock.mock.calls.at(-1)?.[0]).toMatch(/ nx run petstore:orval$/);
    });

    it('uses the package name and the registered target name in a workspaces setup', async () => {
      useWorkspaces(tree);
      updateJson(tree, 'nx.json', (json) => ({
        ...json,
        plugins: [{ plugin: 'nx-orval', options: { targetName: 'codegen' } }],
      }));
      const done = await apiGenerator(tree, { name: 'petstore', skipFormat: true });

      await done();

      expect(generationCalls()[0][0]).toMatch(/ nx run @proj\/petstore:codegen$/);
    });

    it('runs the target of an existing project', async () => {
      addProjectConfiguration(tree, 'web', { root: 'apps/web' });
      tree.write('apps/web/openapi.yaml', 'openapi: 3.0.0');
      const done = await apiGenerator(tree, { project: 'web', skipFormat: true });

      await done();

      expect(generationCalls()[0][0]).toMatch(/ nx run web:orval$/);
    });

    it('only prints the command with --skipGenerate', async () => {
      const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      const done = await apiGenerator(tree, { name: 'petstore', skipGenerate: true, skipFormat: true });

      await done();

      expect(generationCalls()).toHaveLength(0);
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/src\/generated does not exist yet.* nx run petstore:orval$/));
    });

    it('warns with the command instead of failing when generation fails', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      execSyncMock.mockImplementation((command) => {
        if (/\bnx run\b/.test(String(command))) throw new Error('offline');
        return Buffer.from('');
      });
      const done = await apiGenerator(tree, { name: 'petstore', skipFormat: true });

      await expect(done()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/first generation failed.* nx run petstore:orval$/));
    });
  });
});
