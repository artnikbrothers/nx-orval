import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { summarizeOrvalConfig, withConfigEnv } from './orval-config';

const workspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'nx-orval-'));
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  });
  return root;
};

describe('summarizeOrvalConfig', () => {
  it('maps a workspace output and a spec in another project', async () => {
    const root = workspace({
      'libs/client/orval.config.ts': `export default {
        petstore: {
          input: { target: '../../apps/api/openapi.yaml' },
          output: { workspace: './src/generated', target: './petstore.ts' },
        },
      };`,
    });
    await expect(summarizeOrvalConfig(root, 'libs/client/orval.config.ts')).resolves.toEqual({
      localSpecs: ['apps/api/openapi.yaml'],
      remoteSpecs: [],
      outputs: ['libs/client/src/generated'],
      projectNames: ['petstore'],
      cacheBlockers: [],
    });
  });

  it('globs single-file outputs so hand-written neighbours stay out of the cache', async () => {
    const root = workspace({
      'web/orval.config.mjs': `export default () => ({
        a: { input: ['spec.json'], output: { target: 'src/api/a.ts', schemas: 'src/api/model' } },
        b: { input: 'https://example.com/b.json', output: { target: 'src/tags/b.ts', mode: 'tags-split' } },
        logLevel: 'info',
      });`,
    });
    const summary = await summarizeOrvalConfig(root, 'web/orval.config.mjs');
    expect(summary.outputs).toEqual(['web/src/api/a.*', 'web/src/api/model', 'web/src/tags']);
    expect(summary.localSpecs).toEqual(['web/spec.json']);
    expect(summary.remoteSpecs).toEqual(['https://example.com/b.json']);
    expect(summary.projectNames).toEqual(['a', 'b']);
  });

  it('drops outputs nested inside another output', async () => {
    const root = workspace({
      'orval.config.js': `module.exports = {
        a: { input: 'a.yaml', output: { target: 'gen/a', schemas: 'gen/a/model' } },
      };`,
    });
    const summary = await summarizeOrvalConfig(root, 'orval.config.js');
    expect(summary.outputs).toEqual(['gen/a']);
  });

  it('blocks caching when an output would cover the project root or leave the workspace', async () => {
    const root = workspace({
      'libs/client/orval.config.ts': `export default {
        a: { input: 'a.yaml', output: { target: './a.ts', mode: 'tags-split' } },
        b: { input: '../../../outside.yaml', output: { workspace: '.' } },
      };`,
    });
    const summary = await summarizeOrvalConfig(root, 'libs/client/orval.config.ts');
    expect(summary.outputs).toEqual([]);
    expect(summary.localSpecs).toEqual(['libs/client/a.yaml']);
    expect(summary.cacheBlockers).toEqual([
      'spec ../outside.yaml is outside the workspace',
      'output libs/client contains the project root; use a dedicated folder',
    ]);
  });
});

describe('withConfigEnv', () => {
  it('applies env files without overriding real variables, then restores them', async () => {
    const root = workspace({
      'web/.env': 'SPEC_URL="https://example.com/spec.json"\nKEPT=file',
      'web/.env.example': 'ONLY_EXAMPLE=example',
    });
    process.env['KEPT'] = 'real';
    const seen = await withConfigEnv(join(root, 'web'), async () => ({
      spec: process.env['SPEC_URL'],
      kept: process.env['KEPT'],
      example: process.env['ONLY_EXAMPLE'],
    }));
    expect(seen).toEqual({ spec: 'https://example.com/spec.json', kept: 'real', example: 'example' });
    expect([process.env['SPEC_URL'], process.env['ONLY_EXAMPLE'], process.env['KEPT']]).toEqual([
      undefined,
      undefined,
      'real',
    ]);
    delete process.env['KEPT'];
  });
});
