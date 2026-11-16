import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { specRefFiles } from './spec-refs';

const workspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'nx-orval-refs-'));
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  });
  return root;
};

describe('specRefFiles', () => {
  it('returns nothing for a spec with only local fragments', () => {
    const root = workspace({
      'openapi.yaml': `schema:\n  $ref: '#/components/schemas/Pet'\n`,
    });
    expect(specRefFiles(root, ['openapi.yaml'])).toEqual([]);
  });

  it('follows YAML refs with and without ./ prefixes, quotes and fragments', () => {
    const root = workspace({
      'api/openapi.yaml': `a:
  $ref: './one.yaml#/One'
b:
  $ref: "two.yml"
c:
  $ref: ../common/three.yaml
d:
  $ref: 'sub/four.json#/Four'
`,
      'api/one.yaml': '',
      'api/two.yml': '',
      'common/three.yaml': '',
      'api/sub/four.json': '{}',
    });
    expect(specRefFiles(root, ['api/openapi.yaml'])).toEqual([
      'api/one.yaml',
      'api/sub/four.json',
      'api/two.yml',
      'common/three.yaml',
    ]);
  });

  it('follows JSON refs, nested refs and reference cycles', () => {
    const root = workspace({
      'openapi.json': `{ "paths": { "/pets": { "$ref": "./paths/pets.json" } } }`,
      'paths/pets.json': `{ "get": { "schema": { "$ref": "../schemas/pet.json#/Pet" } } }`,
      'schemas/pet.json': `{ "Pet": { "owner": { "$ref": "./owner.json" } } }`,
      'schemas/owner.json': `{ "pet": { "$ref": "./pet.json" }, "root": { "$ref": "../openapi.json" } }`,
    });
    expect(specRefFiles(root, ['openapi.json'])).toEqual([
      'paths/pets.json',
      'schemas/owner.json',
      'schemas/pet.json',
    ]);
  });

  it('ignores URLs, absolute paths, missing files, non-spec files and refs leaving the workspace', () => {
    const outer = workspace({
      'outside.yaml': '',
      'ws/openapi.yaml': `a:
  $ref: 'https://example.com/pet.yaml'
b:
  $ref: '/etc/pet.yaml'
c:
  $ref: './missing.yaml'
d:
  $ref: './notes.md'
e:
  $ref: '../outside.yaml'
`,
      'ws/notes.md': '',
    });
    expect(specRefFiles(join(outer, 'ws'), ['openapi.yaml'])).toEqual([]);
  });

  it('merges the refs of several specs and does not list the specs themselves', () => {
    const root = workspace({
      'a.yaml': `x:\n  $ref: './shared.yaml'\ny:\n  $ref: './b.yaml'\n`,
      'b.yaml': `x:\n  $ref: './shared.yaml'\n`,
      'shared.yaml': '',
    });
    expect(specRefFiles(root, ['a.yaml', 'b.yaml'])).toEqual(['shared.yaml']);
  });

  it('stops at the depth cap and tolerates a missing spec', () => {
    const root = workspace({
      'spec.yaml': `a:\n  $ref: './l1.yaml'\n`,
      'l1.yaml': `a:\n  $ref: './l2.yaml'\n`,
      'l2.yaml': `a:\n  $ref: './l3.yaml'\n`,
      'l3.yaml': '',
    });
    expect(specRefFiles(root, ['spec.yaml'], 2)).toEqual(['l1.yaml', 'l2.yaml']);
    expect(specRefFiles(root, ['gone.yaml'])).toEqual([]);
  });
});
