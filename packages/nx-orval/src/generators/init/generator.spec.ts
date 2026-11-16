import {
  type Tree,
  addProjectConfiguration,
  logger,
  readJson,
  readNxJson,
  updateJson,
  updateNxJson,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { initGenerator } from './generator';

describe('init generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const orvalEntries = (): unknown[] =>
    (readNxJson(tree)?.plugins ?? []).filter(
      (p) => (typeof p === 'string' ? p : p.plugin) === 'nx-orval',
    );

  it('registers the plugin and adds orval', async () => {
    await initGenerator(tree, {});
    expect(readNxJson(tree)?.plugins).toContainEqual({
      plugin: 'nx-orval',
      options: { targetName: 'orval' },
    });
    expect(readJson(tree, 'package.json').devDependencies.orval).toBeDefined();
  });

  it('is idempotent', async () => {
    await initGenerator(tree, {});
    const afterFirst = { nx: tree.read('nx.json', 'utf8'), pkg: tree.read('package.json', 'utf8') };
    await initGenerator(tree, {});

    expect(orvalEntries()).toHaveLength(1);
    expect(tree.read('nx.json', 'utf8')).toBe(afterFirst.nx);
    expect(tree.read('package.json', 'utf8')).toBe(afterFirst.pkg);
  });

  it('respects skipPackageJson', async () => {
    const before = tree.read('package.json', 'utf8');
    await initGenerator(tree, { skipPackageJson: true });

    expect(tree.read('package.json', 'utf8')).toBe(before);
    expect(orvalEntries()).toHaveLength(1);
  });

  it('keeps the orval version the workspace already declares', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: { ...json.devDependencies, orval: '^7.10.0' },
    }));
    await initGenerator(tree, {});

    expect(readJson(tree, 'package.json').devDependencies.orval).toBe('^7.10.0');
  });

  it('raises the orval version when keepExistingVersions is off', async () => {
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      devDependencies: { ...json.devDependencies, orval: '^7.10.0' },
    }));
    await initGenerator(tree, { keepExistingVersions: false });

    expect(readJson(tree, 'package.json').devDependencies.orval).toBe('^8.48.0');
  });

  describe('existing plugin entry', () => {
    it('keeps the options of an object entry', async () => {
      updateNxJson(tree, {
        ...readNxJson(tree),
        plugins: [{ plugin: 'nx-orval', options: { targetName: 'codegen', extra: true } }],
      });
      await initGenerator(tree, { targetName: 'orval' });

      expect(readNxJson(tree)?.plugins).toEqual([
        { plugin: 'nx-orval', options: { targetName: 'codegen', extra: true } },
      ]);
    });

    it('keeps a bare string entry', async () => {
      updateNxJson(tree, { ...readNxJson(tree), plugins: ['nx-orval'] });
      await initGenerator(tree, {});

      expect(readNxJson(tree)?.plugins).toEqual(['nx-orval']);
    });

    it('keeps other plugins in order', async () => {
      updateNxJson(tree, { ...readNxJson(tree), plugins: ['@nx/other/plugin'] });
      await initGenerator(tree, {});

      expect(readNxJson(tree)?.plugins).toEqual([
        '@nx/other/plugin',
        { plugin: 'nx-orval', options: { targetName: 'orval' } },
      ]);
    });
  });

  describe('report', () => {
    const infoMessages = (info: jest.SpyInstance): string[] =>
      info.mock.calls.map(([message]) => String(message));

    it('lists the Orval configs that get an inferred target', async () => {
      const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      addProjectConfiguration(tree, 'web', { root: 'apps/web' });
      tree.write('apps/web/orval.config.ts', 'export default {};');
      tree.write('libs/api/orval.config.mjs', 'export default {};');
      tree.write('libs/api/orval.config.json', '{}');
      await initGenerator(tree, {});

      const [message] = infoMessages(info);
      expect(message).toContain('found 2 Orval configs');
      expect(message).toContain('apps/web/orval.config.ts');
      expect(message).toContain('libs/api/orval.config.mjs');
      expect(message).not.toContain('orval.config.json');
      expect(message).toContain('nx run-many -t orval');
    });

    it('names the registered target when the plugin entry renames it', async () => {
      const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      updateNxJson(tree, {
        ...readNxJson(tree),
        plugins: [{ plugin: 'nx-orval', options: { targetName: 'codegen' } }],
      });
      tree.write('apps/web/orval.config.ts', 'export default {};');
      await initGenerator(tree, {});

      expect(infoMessages(info)[0]).toContain('nx run-many -t codegen');
    });

    it('stays quiet when there is nothing to report', async () => {
      const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      await initGenerator(tree, {});

      expect(info).not.toHaveBeenCalled();
    });

    it('points out package.json scripts that run the Orval CLI', async () => {
      const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      updateJson(tree, 'package.json', (json) => ({
        ...json,
        scripts: {
          'generate:api': 'orval --config ./orval.config.ts',
          sdk: 'npx orval',
          codegen: 'nx run-many -t orval',
          lint: 'eslint .',
        },
      }));
      tree.write('apps/web/package.json', JSON.stringify({ name: 'web', scripts: { orval: 'orval' } }));
      await initGenerator(tree, {});

      const message = infoMessages(info).join('\n');
      expect(message).toContain('"generate:api" in package.json');
      expect(message).toContain('"sdk" in package.json');
      expect(message).toContain('"orval" in apps/web/package.json');
      expect(message).not.toContain('"codegen"');
      expect(message).not.toContain('"lint"');
    });

    it('does not touch files while reporting', async () => {
      jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      tree.write('apps/web/orval.config.ts', 'export default {};');
      tree.write('apps/web/package.json', '{ not json');
      const before = tree.read('apps/web/package.json', 'utf8');

      await expect(initGenerator(tree, {})).resolves.toBeDefined();

      expect(tree.read('apps/web/package.json', 'utf8')).toBe(before);
    });
  });
});
