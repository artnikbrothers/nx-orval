import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');

interface SchemaProperty {
  readonly description?: string;
  readonly default?: unknown;
  readonly 'x-prompt'?: string | { readonly message: string };
  readonly 'x-priority'?: string;
  readonly 'x-completion-type'?: string;
}

interface Schema {
  readonly $id?: string;
  readonly cli?: string;
  readonly title?: string;
  readonly description?: string;
  readonly examples?: ReadonlyArray<{ command: string; description: string }>;
  readonly properties: Readonly<Record<string, SchemaProperty>>;
  readonly required?: readonly string[];
}

interface GeneratorEntry {
  readonly factory: string;
  readonly schema: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly 'x-type'?: string;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(PACKAGE_ROOT, path), 'utf8')) as T;

const { generators } = readJson<{ generators: Record<string, GeneratorEntry> }>('generators.json');

describe('generators.json', () => {
  it.each(Object.entries(generators))('%s points at files that exist and says what it does', (_name, entry) => {
    expect(existsSync(join(PACKAGE_ROOT, `${entry.factory}.ts`))).toBe(true);
    expect(existsSync(join(PACKAGE_ROOT, entry.schema))).toBe(true);
    expect(entry.description?.length).toBeGreaterThan(20);
  });

  it('marks api as a library generator reachable as "client"', () => {
    expect(generators['api']['x-type']).toBe('library');
    expect(generators['api'].aliases).toContain('client');
  });

  it('marks init as an init generator', () => {
    expect(generators['init']['x-type']).toBe('init');
  });
});

describe.each(Object.entries(generators))('%s schema', (name, entry) => {
  const schema = readJson<Schema>(entry.schema);

  it('carries the metadata Nx help and Nx Console read', () => {
    expect(schema.$id).toMatch(/^NxOrval/);
    expect(schema.cli).toBe('nx');
    expect(schema.title).toBeTruthy();
    expect(schema.description?.length).toBeGreaterThan(20);
    expect(schema.examples?.length).toBeGreaterThan(0);
  });

  it('describes every option', () => {
    const missing = Object.entries(schema.properties)
      .filter(([, property]) => !property.description)
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('only shows examples that use real options of this generator', () => {
    schema.examples?.forEach(({ command, description }) => {
      expect(description).toBeTruthy();
      expect(command).toMatch(new RegExp(`^nx g nx-orval:${name}\\b`));
      const flags = [...command.matchAll(/--([A-Za-z]+)/g)].map((match) => match[1]);
      flags.forEach((flag) => expect(Object.keys(schema.properties)).toContain(flag));
    });
  });
});

describe('api schema', () => {
  const { properties, required } = readJson<Schema>('src/generators/api/schema.json');

  it('puts the main options first for Nx Console', () => {
    expect(['name', 'spec', 'client'].map((key) => properties[key]['x-priority'])).toEqual([
      'important',
      'important',
      'important',
    ]);
  });

  it('asks for the spec and offers the sample', () => {
    expect(properties['spec']['x-prompt']).toBe('Path or URL of the OpenAPI spec (leave empty for a sample)');
    expect(properties['spec']['x-completion-type']).toBe('file');
  });

  it('does not require a name, so --project can supply it', () => {
    expect(required ?? []).not.toContain('name');
  });

  it('leaves the linter to the workspace', () => {
    expect(properties['linter'].default).toBeUndefined();
  });

  it('runs the first generation unless told not to', () => {
    expect(properties['skipGenerate'].default).toBe(false);
  });
});

describe('init schema', () => {
  const { properties } = readJson<Schema>('src/generators/init/schema.json');

  it('declares keepExistingVersions, which `nx add` looks for', () => {
    expect(properties['keepExistingVersions'].default).toBe(true);
    expect(properties['keepExistingVersions']['x-priority']).toBe('internal');
  });
});
