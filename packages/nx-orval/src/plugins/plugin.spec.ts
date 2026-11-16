import type { CreateDependenciesContext, CreateNodesContext, TargetConfiguration } from '@nx/devkit';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDependencies, createNodes } from './plugin';

const workspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'nx-orval-plugin-'));
  write(root, files);
  return root;
};

const write = (root: string, files: Record<string, string>): void =>
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  });

const config = (target: string): string => `export default {
  petstore: {
    input: { target: '${target}' },
    output: { workspace: './src/generated', target: './petstore.ts' },
  },
};`;

const contextFor = (root: string): CreateNodesContext => ({
  nxJsonConfiguration: {},
  workspaceRoot: root,
});

const DATA_ENV_VARS = ['NX_WORKSPACE_DATA_DIRECTORY', 'NX_PROJECT_GRAPH_CACHE_DIRECTORY'] as const;

describe('nx-orval plugin', () => {
  const [pattern, createNodesFn] = createNodes;

  /** Runs createNodes for one config and returns the project's inferred target. */
  const inferTarget = async (
    root: string,
    configFile: string,
    projectRoot: string,
    options: Parameters<typeof createNodesFn>[1] = {},
  ): Promise<TargetConfiguration | undefined> => {
    const results = await createNodesFn([configFile], options, contextFor(root));
    return results[0]?.[1].projects?.[projectRoot]?.targets?.[options?.targetName ?? 'orval'];
  };

  beforeEach(() => {
    DATA_ENV_VARS.forEach((name) => delete process.env[name]);
    process.env['NX_WORKSPACE_DATA_DIRECTORY'] = mkdtempSync(join(tmpdir(), 'nx-orval-data-'));
  });

  afterAll(() => {
    DATA_ENV_VARS.forEach((name) => delete process.env[name]);
  });

  it('matches every Orval config extension', () => {
    expect(pattern).toBe('**/orval.config.{ts,mts,cts,js,mjs,cjs}');
  });

  it('infers a cached orval target with spec inputs and generated outputs', async () => {
    const root = workspace({
      'libs/client/project.json': '{}',
      'libs/client/orval.config.ts': config('../../apps/api/openapi.yaml'),
    });
    const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');

    expect(target).toMatchObject({
      command: 'orval --config orval.config.ts',
      options: { cwd: 'libs/client' },
      cache: true,
      inputs: expect.arrayContaining([
        '{projectRoot}/**/*',
        '!{projectRoot}/src/generated',
        '!{projectRoot}/src/generated/**/*',
        '{workspaceRoot}/apps/api/openapi.yaml',
        '{workspaceRoot}/apps/api/**/*.{yaml,yml,json}',
        '{workspaceRoot}/.editorconfig',
        '{workspaceRoot}/.prettierignore',
        { externalDependencies: ['orval'] },
      ]),
      outputs: ['{workspaceRoot}/libs/client/src/generated'],
    });
  });

  describe('target metadata', () => {
    it('gives help a real example and no cache note when the target is cached', async () => {
      const root = workspace({
        'package-lock.json': '{}',
        'libs/client/project.json': '{}',
        'libs/client/orval.config.ts': config('../../apps/api/openapi.yaml'),
      });
      const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');

      expect(target?.metadata).toMatchObject({
        technologies: ['orval'],
        description: 'Generate API clients with Orval (petstore)',
        help: { command: 'npx orval --help', example: { options: { project: 'petstore' } } },
      });
    });

    it('follows the workspace package manager in the help command', async () => {
      const root = workspace({
        'pnpm-lock.yaml': '',
        'libs/client/project.json': '{}',
        'libs/client/orval.config.ts': config('spec.yaml'),
      });
      const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');
      expect(target?.metadata?.help?.command).toBe('pnpm exec orval --help');
    });

    it('explains in the description why a target is not cached', async () => {
      const root = workspace({
        'web/package.json': '{}',
        'web/orval.config.ts': config('https://example.com/openapi.json?token=secret'),
      });
      const target = await inferTarget(root, 'web/orval.config.ts', 'web');

      expect(target?.cache).toBe(false);
      expect(target?.metadata?.description).toBe(
        'Generate API clients with Orval (petstore). Caching off: remote spec (set cacheRemoteSpecs to cache it)',
      );
      expect(JSON.stringify(target?.metadata)).not.toContain('secret');
    });

    it('keeps help on the fallback target', async () => {
      const root = workspace({
        'package-lock.json': '{}',
        'web/project.json': '{}',
        'web/orval.config.ts': `throw new Error('SPEC_URL is not set');`,
      });
      const target = await inferTarget(root, 'web/orval.config.ts', 'web');
      expect(target?.metadata?.help).toEqual({
        command: 'npx orval --help',
        example: { options: { project: 'petstore' } },
      });
    });
  });

  describe('spec inputs', () => {
    it('keeps package, project and tsconfig files beside a spec out of the inputs', async () => {
      const root = workspace({
        'libs/client/project.json': '{}',
        'libs/client/orval.config.ts': config('../../apps/api/openapi.yaml'),
      });
      const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');
      expect(target?.inputs).toEqual(
        expect.arrayContaining([
          '{workspaceRoot}/apps/api/**/*.{yaml,yml,json}',
          '!{workspaceRoot}/apps/api/**/{package.json,project.json,tsconfig*.json}',
        ]),
      );
    });

    it('tracks a split spec in the workspace root through its $ref files', async () => {
      const root = workspace({
        'libs/client/project.json': '{}',
        'libs/client/orval.config.ts': config('../../openapi.yaml'),
        'openapi.yaml': `openapi: 3.0.0
paths:
  /pets:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: './schemas/pet.yaml#/Pet'
`,
        'schemas/pet.yaml': `Pet:
  properties:
    tag:
      $ref: 'tag.yaml'
`,
        'schemas/tag.yaml': 'type: string\n',
        'package.json': '{}',
      });
      const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');
      const inputs = target?.inputs ?? [];

      expect(inputs).toEqual(
        expect.arrayContaining([
          '{workspaceRoot}/openapi.yaml',
          '{workspaceRoot}/schemas/pet.yaml',
          '{workspaceRoot}/schemas/tag.yaml',
        ]),
      );
      // A folder glob for the workspace root would match the whole repo.
      expect(inputs.filter((input) => typeof input === 'string' && input.includes('*.{'))).toEqual(
        [],
      );
      expect(inputs).not.toContainEqual(expect.stringContaining('/./'));
    });

    it('tracks $ref files that leave the spec folder', async () => {
      const root = workspace({
        'libs/client/project.json': '{}',
        'libs/client/orval.config.ts': config('../../apps/api/openapi.yaml'),
        'apps/api/openapi.yaml': `components:
  schemas:
    Error:
      $ref: '../../shared/errors.yaml#/Error'
`,
        'shared/errors.yaml': 'Error:\n  type: object\n',
      });
      const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');
      expect(target?.inputs).toContain('{workspaceRoot}/shared/errors.yaml');
    });
  });

  describe('config imports', () => {
    const sharedConfig = `import { out } from '../../tools/orval/shared';
export default {
  petstore: { input: './spec.yaml', output: { workspace: out, target: './api' } },
};`;

    it('refreshes outputs and inputs when an imported module changes', async () => {
      const root = workspace({
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': sharedConfig,
        'tools/orval/shared.ts': `export const out = './src/gen-v1';`,
      });

      const before = await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(before?.outputs).toEqual(['{workspaceRoot}/libs/f/src/gen-v1']);
      expect(before?.inputs).toContain('{workspaceRoot}/tools/orval/shared.ts');

      write(root, { 'tools/orval/shared.ts': `export const out = './src/gen-v2';` });
      const after = await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(after?.outputs).toEqual(['{workspaceRoot}/libs/f/src/gen-v2']);
    });

    it('follows imports through several modules', async () => {
      const root = workspace({
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': `import { out } from './local';
export default { a: { input: './spec.yaml', output: { workspace: out, target: './api' } } };`,
        'libs/f/local.ts': `export { out } from '../../tools/orval/base';`,
        'tools/orval/base.ts': `export const out = './src/gen-v1';`,
      });
      const target = await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');

      // The module inside the project is covered by the project-wide input.
      expect(target?.inputs).toContain('{workspaceRoot}/tools/orval/base.ts');
      expect(target?.inputs).not.toContain('{workspaceRoot}/libs/f/local.ts');

      write(root, { 'tools/orval/base.ts': `export const out = './src/gen-v2';` });
      const after = await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(after?.outputs).toEqual(['{workspaceRoot}/libs/f/src/gen-v2']);
    });

    it('reuses the cached analysis while nothing the config reads has changed', async () => {
      // The config loads outside the Jest sandbox, so it logs each evaluation to a file.
      const log = join(mkdtempSync(join(tmpdir(), 'nx-orval-evals-')), 'log.txt');
      const root = workspace({
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'x');
export default { a: { input: './spec.yaml', output: { workspace: './gen', target: './api' } } };`,
      });
      const evaluations = (): number => (existsSync(log) ? readFileSync(log, 'utf8').length : 0);

      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(evaluations()).toBe(1);

      write(root, { 'libs/f/.env': 'CHANGED=1' });
      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(evaluations()).toBe(2);
    });

    it('re-analyses when the project root changes', async () => {
      const root = workspace({
        'libs/a/b/project.json': '{}',
        'libs/a/b/orval.config.ts': `export default {
          a: { input: './spec.yaml', output: { workspace: '.', target: './api' } },
        };`,
      });
      const nested = await inferTarget(root, 'libs/a/b/orval.config.ts', 'libs/a/b');
      expect(nested?.cache).toBe(false);

      renameSync(join(root, 'libs/a/b/project.json'), join(root, 'libs/a/project.json'));
      const parent = await inferTarget(root, 'libs/a/b/orval.config.ts', 'libs/a');
      expect(parent).toMatchObject({
        cache: true,
        outputs: ['{workspaceRoot}/libs/a/b'],
      });
    });
  });

  describe('graph cache', () => {
    const cacheFiles = (dir: string): string[] =>
      existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('nx-orval-')) : [];

    it('resolves a relative data directory against the workspace root', async () => {
      const root = workspace({
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': config('spec.yaml'),
      });
      process.env['NX_WORKSPACE_DATA_DIRECTORY'] = 'custom/data';
      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');

      const files = cacheFiles(join(root, 'custom/data'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^nx-orval-[0-9a-f]{12}\.hash\.json$/);
    });

    it('honours the legacy graph cache variable and defaults to .nx/workspace-data', async () => {
      const root = workspace({
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': config('spec.yaml'),
      });
      delete process.env['NX_WORKSPACE_DATA_DIRECTORY'];
      process.env['NX_PROJECT_GRAPH_CACHE_DIRECTORY'] = 'legacy';
      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(cacheFiles(join(root, 'legacy'))).toHaveLength(1);

      delete process.env['NX_PROJECT_GRAPH_CACHE_DIRECTORY'];
      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(cacheFiles(join(root, '.nx', 'workspace-data'))).toHaveLength(1);
    });

    it('leaves no temp files behind', async () => {
      const root = workspace({
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': config('spec.yaml'),
      });
      await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      const names = readdirSync(process.env['NX_WORKSPACE_DATA_DIRECTORY'] ?? '');
      expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('still infers targets when the cache cannot be written', async () => {
      const root = workspace({
        'blocker': 'a file, so the data directory cannot be created below it',
        'libs/f/project.json': '{}',
        'libs/f/orval.config.ts': config('spec.yaml'),
      });
      process.env['NX_WORKSPACE_DATA_DIRECTORY'] = join(root, 'blocker', 'data');

      const target = await inferTarget(root, 'libs/f/orval.config.ts', 'libs/f');
      expect(target).toMatchObject({ cache: true, outputs: ['{workspaceRoot}/libs/f/src/generated'] });
    });
  });

  it('does not cache configs with remote specs unless asked to', async () => {
    const root = workspace({
      'web/package.json': '{}',
      'web/orval.config.ts': config('https://example.com/openapi.json'),
    });
    const off = await inferTarget(root, 'web/orval.config.ts', 'web', { targetName: 'api' });
    const on = await inferTarget(root, 'web/orval.config.ts', 'web', { cacheRemoteSpecs: true });

    expect(off?.cache).toBe(false);
    expect(on?.cache).toBe(true);
  });

  it('skips configs outside a project', async () => {
    const root = workspace({ 'tools/orval.config.ts': config('spec.yaml') });
    const results = await createNodesFn(['tools/orval.config.ts'], {}, contextFor(root));
    expect(results[0]?.[1]).toEqual({});
  });

  it('attaches a config in a subfolder to the nearest project', async () => {
    const root = workspace({
      'libs/data/project.json': '{}',
      'libs/data/src/lib/orval-config/orval.config.ts': `export default {
        a: { input: './spec.yaml', output: { workspace: '../v1', target: './api' } },
      };`,
    });
    const target = await inferTarget(
      root,
      'libs/data/src/lib/orval-config/orval.config.ts',
      'libs/data',
    );
    expect(target).toMatchObject({
      options: { cwd: 'libs/data/src/lib/orval-config' },
      cache: true,
      outputs: ['{workspaceRoot}/libs/data/src/lib/v1'],
    });
  });

  it('falls back to an uncached target when the config throws', async () => {
    const root = workspace({
      'web/project.json': '{}',
      'web/orval.config.ts': `throw new Error('SPEC_URL is not set');`,
    });
    const target = await inferTarget(root, 'web/orval.config.ts', 'web');
    expect(target).toMatchObject({
      command: 'orval --config orval.config.ts',
      cache: false,
    });
  });

  describe('createDependencies', () => {
    const dependencyContext = (
      projects: CreateDependenciesContext['projects'],
      workspaceRoot: string,
    ): CreateDependenciesContext => ({
      externalNodes: {},
      nxJsonConfiguration: {},
      workspaceRoot,
      projects,
      fileMap: {
        projectFileMap: {
          client: [{ file: 'libs/client/orval.config.ts', hash: '1' }],
          api: [{ file: 'apps/api/openapi.yaml', hash: '2' }],
        },
        nonProjectFiles: [],
      },
      filesToProcess: { projectFileMap: {}, nonProjectFiles: [] },
    });

    const clientRoot = async (): Promise<{ root: string; target: TargetConfiguration }> => {
      const root = workspace({
        'libs/client/project.json': '{}',
        'libs/client/orval.config.ts': config('../../apps/api/openapi.yaml'),
      });
      const target = await inferTarget(root, 'libs/client/orval.config.ts', 'libs/client');
      if (!target) throw new Error('no target inferred');
      return { root, target };
    };

    it('links the client project to the project that owns the spec', async () => {
      const { root, target } = await clientRoot();
      const context = dependencyContext(
        {
          client: { root: 'libs/client', targets: { orval: target } },
          api: { root: 'apps/api' },
        },
        root,
      );

      expect(await createDependencies({}, context)).toEqual([
        {
          source: 'client',
          target: 'api',
          sourceFile: 'libs/client/orval.config.ts',
          type: 'static',
        },
      ]);
    });

    it('needs no files on disk, so any process and any cache state gets the edges', async () => {
      const { target } = await clientRoot();
      const emptyWorkspace = mkdtempSync(join(tmpdir(), 'nx-orval-empty-'));
      process.env['NX_WORKSPACE_DATA_DIRECTORY'] = join(emptyWorkspace, 'no-such-dir');
      const context = dependencyContext(
        {
          client: { root: 'libs/client', targets: { orval: target } },
          api: { root: 'apps/api' },
        },
        emptyWorkspace,
      );

      expect(await createDependencies({}, context)).toHaveLength(1);
    });

    it('reads the configured target name', async () => {
      const { root, target } = await clientRoot();
      const projects = {
        client: { root: 'libs/client', targets: { 'generate-api': target } },
        api: { root: 'apps/api' },
      };
      const context = dependencyContext(projects, root);

      expect(await createDependencies({ targetName: 'generate-api' }, context)).toHaveLength(1);
      expect(await createDependencies({}, context)).toEqual([]);
    });

    it('adds no edges when inferDependencies is off, the spec is local or the metadata is odd', async () => {
      const { root, target } = await clientRoot();
      const projects = {
        client: { root: 'libs/client', targets: { orval: target } },
        api: { root: 'apps/api' },
      };

      expect(
        await createDependencies({ inferDependencies: false }, dependencyContext(projects, root)),
      ).toEqual([]);

      // The spec's owner is the client itself.
      expect(
        await createDependencies(
          {},
          dependencyContext({ client: { root: 'libs/client', targets: { orval: target } } }, root),
        ),
      ).toEqual([]);

      const odd: TargetConfiguration = { ...target, metadata: { orval: { specs: [1] } } };
      expect(
        await createDependencies(
          {},
          dependencyContext(
            { client: { root: 'libs/client', targets: { orval: odd } }, api: { root: 'apps/api' } },
            root,
          ),
        ),
      ).toEqual([]);
    });
  });
});
