import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { importClosure } from './import-closure';

const workspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'nx-orval-imports-'));
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  });
  return root;
};

describe('importClosure', () => {
  it('returns nothing for a self-contained config', () => {
    const root = workspace({ 'web/orval.config.ts': 'export default {};' });
    expect(importClosure(root, 'web/orval.config.ts')).toEqual([]);
  });

  it('collects import, export-from, dynamic import and require specifiers', () => {
    const root = workspace({
      'web/orval.config.ts': `import base from '../tools/base';
import type { Shape } from "./types";
import './side-effect';
export * from '../tools/re-export';
const lazy = () => import('./lazy');
const legacy = require('./legacy.cjs');
import fs from 'node:fs';
import dotenv from 'dotenv';
export default {};`,
      'tools/base.ts': 'export default {};',
      'web/types.ts': 'export type Shape = {};',
      'web/side-effect.ts': '',
      'tools/re-export.mts': '',
      'web/lazy.js': '',
      'web/legacy.cjs': '',
    });
    expect(importClosure(root, 'web/orval.config.ts')).toEqual([
      'tools/base.ts',
      'tools/re-export.mts',
      'web/lazy.js',
      'web/legacy.cjs',
      'web/side-effect.ts',
      'web/types.ts',
    ]);
  });

  it('resolves folders to their index file and `.js` specifiers to TypeScript sources', () => {
    const root = workspace({
      'web/orval.config.ts': `import a from './shared';
import b from './esm.js';
import c from '..';
export default {};`,
      'web/shared/index.ts': '',
      'web/esm.ts': '',
      'index.ts': '',
    });
    expect(importClosure(root, 'web/orval.config.ts')).toEqual([
      'index.ts',
      'web/esm.ts',
      'web/shared/index.ts',
    ]);
  });

  it('follows imports recursively and survives import cycles', () => {
    const root = workspace({
      'web/orval.config.ts': `import { a } from './a'; export default {};`,
      'web/a.ts': `import { b } from './b'; export const a = 1;`,
      'web/b.ts': `import { a } from './a'; import { c } from '../lib/c'; export const b = 2;`,
      'lib/c.ts': `import data from './data.json'; export const c = 3;`,
      'lib/data.json': `{ "import": "./never-read.ts" }`,
    });
    expect(importClosure(root, 'web/orval.config.ts')).toEqual([
      'lib/c.ts',
      'lib/data.json',
      'web/a.ts',
      'web/b.ts',
    ]);
  });

  it('stops at the depth cap', () => {
    const root = workspace({
      'orval.config.ts': `import './m1'; export default {};`,
      'm1.ts': `import './m2';`,
      'm2.ts': `import './m3';`,
      'm3.ts': '',
    });
    expect(importClosure(root, 'orval.config.ts', 2)).toEqual(['m1.ts', 'm2.ts']);
    expect(importClosure(root, 'orval.config.ts')).toEqual(['m1.ts', 'm2.ts', 'm3.ts']);
  });

  it('ignores missing files and never enters node_modules', () => {
    const root = workspace({
      'web/orval.config.ts': `import './missing';
import '../node_modules/pkg/index';
export default {};`,
      'node_modules/pkg/index.ts': '',
    });
    expect(importClosure(root, 'web/orval.config.ts')).toEqual([]);
  });

  it('reports files outside the workspace root with a leading ../', () => {
    const outer = workspace({
      'shared.ts': '',
      'ws/web/orval.config.ts': `import '../../shared'; export default {};`,
    });
    expect(importClosure(join(outer, 'ws'), 'web/orval.config.ts')).toEqual(['../shared.ts']);
  });
});
