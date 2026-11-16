import type { ExecutorContext } from '@nx/devkit';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import runExecutor, { buildArgs, resolveOrvalBin } from './executor';

const workspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'nx-orval-executor-'));
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  });
  return root;
};

/**
 * A stand-in Orval CLI that records its arguments and working directory, and
 * fails when a `fail.flag` file sits in the folder it runs from.
 */
const FAKE_CLI = `require('node:fs').writeFileSync(
  'invocation.json',
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }),
);
process.exit(require('node:fs').existsSync('fail.flag') ? 2 : 0);
`;

const contextFor = (root: string, projectName?: string): ExecutorContext => ({
  root,
  cwd: root,
  isVerbose: false,
  projectName,
  projectsConfigurations: { version: 2, projects: { client: { root: 'libs/client' } } },
  nxJsonConfiguration: {},
  projectGraph: { nodes: {}, dependencies: {} },
});

describe('generate executor', () => {
  it('passes config, project filter and extra args to the Orval CLI', () => {
    expect(
      buildArgs('/ws/libs/api/orval.config.ts', { project: 'petstore', args: ['--clean'] }),
    ).toEqual(['--config', '/ws/libs/api/orval.config.ts', '--project', 'petstore', '--clean']);
  });

  it('omits the project filter when none is set', () => {
    expect(buildArgs('/ws/orval.config.ts', {})).toEqual(['--config', '/ws/orval.config.ts']);
  });

  describe('resolveOrvalBin', () => {
    it('finds the bin of an Orval package with a plain main entry', () => {
      const root = workspace({
        'node_modules/orval/package.json': JSON.stringify({
          name: 'orval',
          main: './dist/index.js',
          bin: { orval: './dist/bin/orval.js' },
        }),
        'node_modules/orval/dist/index.js': '',
        'node_modules/orval/dist/bin/orval.js': '',
      });
      expect(resolveOrvalBin(root)).toBe(join(root, 'node_modules/orval/dist/bin/orval.js'));
    });

    it('finds the bin of an ESM-only Orval package with an exports map', () => {
      const root = workspace({
        'node_modules/orval/package.json': JSON.stringify({
          name: 'orval',
          type: 'module',
          exports: { '.': './dist/index.mjs', './package.json': './package.json' },
          bin: { orval: './dist/bin/orval.mjs' },
        }),
        'node_modules/orval/dist/index.mjs': '',
        'node_modules/orval/dist/bin/orval.mjs': '',
      });
      expect(resolveOrvalBin(root)).toBe(join(root, 'node_modules/orval/dist/bin/orval.mjs'));
    });

    it('accepts a string bin field', () => {
      const root = workspace({
        'node_modules/orval/package.json': JSON.stringify({
          name: 'orval',
          main: './index.js',
          bin: './cli.js',
        }),
        'node_modules/orval/index.js': '',
        'node_modules/orval/cli.js': '',
      });
      expect(resolveOrvalBin(root)).toBe(join(root, 'node_modules/orval/cli.js'));
    });
  });

  describe('running', () => {
    const installFakeOrval = (extra: Record<string, string> = {}): string =>
      workspace({
        'node_modules/orval/package.json': JSON.stringify({
          name: 'orval',
          main: './index.js',
          bin: { orval: './cli.js' },
        }),
        'node_modules/orval/index.js': '',
        'node_modules/orval/cli.js': FAKE_CLI,
        'libs/client/orval.config.mjs': 'export default {};',
        ...extra,
      });

    const invocation = (root: string, folder: string): { args: string[]; cwd: string } =>
      JSON.parse(readFileSync(join(root, folder, 'invocation.json'), 'utf8'));

    it('runs the CLI from the config folder with the project config found by name', async () => {
      const root = installFakeOrval();
      const result = await runExecutor({ project: 'petstore' }, contextFor(root, 'client'));

      expect(result).toEqual({ success: true });
      const { args, cwd } = invocation(root, 'libs/client');
      expect(args).toEqual([
        '--config',
        join(root, 'libs/client/orval.config.mjs'),
        '--project',
        'petstore',
      ]);
      expect(cwd).toContain('libs/client');
    });

    it('uses the config option relative to the workspace root', async () => {
      const root = installFakeOrval({ 'tools/api/orval.config.ts': 'export default {};' });
      const result = await runExecutor(
        { config: 'tools/api/orval.config.ts' },
        contextFor(root, 'client'),
      );

      expect(result).toEqual({ success: true });
      expect(invocation(root, 'tools/api').args).toEqual([
        '--config',
        join(root, 'tools/api/orval.config.ts'),
      ]);
    });

    it('reports failure when the CLI exits non-zero', async () => {
      const root = installFakeOrval({ 'libs/client/fail.flag': '' });
      await expect(runExecutor({}, contextFor(root, 'client'))).resolves.toEqual({
        success: false,
      });
    });

    it('explains a missing config instead of spawning the CLI', async () => {
      const root = installFakeOrval();
      await expect(runExecutor({ config: 'nope/orval.config.ts' }, contextFor(root))).rejects.toThrow(
        'Orval config nope/orval.config.ts does not exist',
      );
      await expect(runExecutor({}, contextFor(root))).rejects.toThrow('set the "config" option');
      expect(existsSync(join(root, 'libs/client/invocation.json'))).toBe(false);
    });
  });
});
