import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// Nx version of the test workspace. CI sets it to cover the supported range.
const NX_VERSION = process.env['NX_ORVAL_E2E_NX_VERSION'] ?? '24.0.1';

// create-nx-workspace clones a template that pins its own Nx version, whatever version of the CLI runs.
// The workspace is bootstrapped with a fixed release and then moved to the Nx version under test.
const BOOTSTRAP_VERSION = '24.0.1';

interface RootPackageJson {
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ProjectDetails {
  targets?: Record<string, { cache?: boolean; metadata?: { technologies?: string[] } }>;
}

describe('nx-orval', () => {
  let projectDirectory: string;

  // The outer `nx e2e --skip-nx-cache` leaks NX_SKIP_NX_CACHE into this process; the test workspace needs its own cache.
  const childEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, NX_DAEMON: 'false', CI: 'true', FORCE_COLOR: '0' };
    delete env.NX_SKIP_NX_CACHE;
    return env;
  };

  const run = (command: string): string =>
    execSync(command, { cwd: projectDirectory, encoding: 'utf-8', stdio: 'pipe', env: childEnv() });

  const readText = (path: string): string => readFileSync(join(projectDirectory, path), 'utf-8');

  const readJson = <T extends object>(path: string): T => JSON.parse(readText(path)) as T;

  const exists = (path: string): boolean => existsSync(join(projectDirectory, path));

  const listFiles = (path: string): string[] => {
    const root = join(projectDirectory, path);
    if (!existsSync(root)) return [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    return walk(root).map((file) => file.slice(root.length + 1));
  };

  // Where the api generator puts a library by default: the parent of the first `<dir>/*` workspaces glob, else `libs`.
  const libraryRoot = (name: string): string => {
    const { workspaces } = readJson<RootPackageJson>('package.json');
    const globs = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
    const parent = globs.map((glob) => /^(.+)\/\*{1,2}$/.exec(glob)?.[1]).find(Boolean) ?? 'libs';
    return `${parent}/${name}`;
  };

  const isCoveredByWorkspaces = (): boolean => {
    const { workspaces } = readJson<RootPackageJson>('package.json');
    return (Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? [])).length > 0;
  };

  const projectNameOf = (libDir: string): string =>
    exists(join(libDir, 'package.json'))
      ? readJson<{ name: string }>(join(libDir, 'package.json')).name
      : (libDir.split('/').pop() ?? libDir);

  // Installs the plugin built from the current source via the local registry started in globalSetup,
  // the way users do: `nx add` installs the package and runs its init generator.
  beforeAll(() => {
    projectDirectory = createTestProject();
    execSync('npx nx add nx-orval@e2e', {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: childEnv(),
    });
  }, 600_000);

  afterAll(() => {
    if (projectDirectory && !process.env.NX_ORVAL_E2E_KEEP) {
      rmSync(projectDirectory, { recursive: true, force: true });
    }
  });

  it('runs on the Nx version under test', () => {
    const installed = readJson<{ version: string }>('node_modules/nx/package.json').version;
    expect(installed).toBe(NX_VERSION);
  });

  it('should be installed', () => {
    execSync('npm ls nx-orval', { cwd: projectDirectory, stdio: 'inherit' });
  });

  describe('nx add', () => {
    it('registers the plugin in nx.json and adds orval to package.json', () => {
      const nxJson = readJson<{ plugins?: Array<string | { plugin: string }> }>('nx.json');
      const pluginNames = (nxJson.plugins ?? []).map((p) => (typeof p === 'string' ? p : p.plugin));
      expect(pluginNames).toContain('nx-orval');

      const pkg = readJson<RootPackageJson>('package.json');
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      expect(deps['nx-orval']).toBeDefined();
      expect(deps['orval']).toBeDefined();
    });

    it('is safe to rerun: init leaves an adopted workspace unchanged', () => {
      const snapshot = (): string[] => [readText('nx.json'), readText('package.json')];
      const before = snapshot();

      run('npx nx g nx-orval:init --no-interactive');

      expect(snapshot()).toEqual(before);
    }, 300_000);
  });

  describe('api generator (petstore, fetch client)', () => {
    let project: string;
    const libDir = (): string => libraryRoot('petstore');

    it('creates a library with an Orval config and a sample spec', () => {
      run('npx nx g nx-orval:api petstore --no-interactive');
      run('npm install');

      expect(exists(join(libDir(), 'orval.config.ts'))).toBe(true);
      expect(exists(join(libDir(), 'openapi.yaml'))).toBe(true);
      project = projectNameOf(libDir());
      expect(project).toMatch(/petstore$/);
    }, 600_000);

    it('links the library into node_modules when the workspaces cover it', () => {
      if (!isCoveredByWorkspaces()) return;
      expect(exists(join('node_modules', project))).toBe(true);
    });

    it('generates the client right after creating the library', () => {
      const files = listFiles(join(libDir(), 'src/generated/client'));
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain('index.ts');
    });

    it('infers an orval target for the new project', () => {
      const projects: string[] = JSON.parse(run('npx nx show projects --with-target orval --json'));
      expect(projects).toContain(project);

      const details = JSON.parse(run(`npx nx show project ${project} --json`)) as ProjectDetails;
      expect(details.targets?.['orval']?.cache).toBe(true);
      expect(details.targets?.['orval']?.metadata?.technologies).toContain('orval');
    }, 300_000);

    it('runs orval and writes the generated client', () => {
      run(`npx nx run ${project}:orval --skip-nx-cache`);

      const files = listFiles(join(libDir(), 'src/generated/client'));
      expect(files.length).toBeGreaterThan(0);
      // schemas: './models', operationSchemas: './models/operations', indexFiles: true
      expect(files.some((f) => f.startsWith('models/') || f.startsWith('models\\'))).toBe(true);
      expect(files.some((f) => /models[\\/]operations[\\/]/.test(f))).toBe(true);
      expect(files).toContain('models/index.ts');
      // mode: 'tags' writes one file per OpenAPI tag next to the index
      expect(files).toContain('pets.ts');
      expect(files).toContain('index.ts');
    }, 600_000);

    it('serves the second run from the Nx cache', () => {
      run(`npx nx run ${project}:orval`);
      const output = run(`npx nx run ${project}:orval`);
      expect(output).toMatch(/existing outputs match the cache|\[local cache\]|1 cached|1\/1 hit/);
    }, 600_000);

    it('typechecks the generated library', () => {
      run(`npx tsc -p ${libDir()}/tsconfig.lib.json --noEmit`);
    }, 600_000);
  });

  describe('api generator (--skipGenerate)', () => {
    it('creates the library without running orval', () => {
      const libDir = libraryRoot('offline');
      run('npx nx g nx-orval:api offline --skipGenerate --no-interactive');
      run('npm install');

      expect(exists(join(libDir, 'orval.config.ts'))).toBe(true);
      expect(exists(join(libDir, 'src/generated'))).toBe(false);

      run(`npx nx run ${projectNameOf(libDir)}:orval --skip-nx-cache`);
      expect(listFiles(join(libDir, 'src/generated/client')).length).toBeGreaterThan(0);
    }, 900_000);
  });

  describe('api generator (valibot validation)', () => {
    it('generates valibot schemas', () => {
      const libDir = libraryRoot('pets-valibot');
      run('npx nx g nx-orval:api pets-valibot --validation=valibot --no-interactive');
      run('npm install');

      const generated = join(libDir, 'src/generated/valibot');
      const tsFiles = listFiles(generated).filter((f) => f.endsWith('.ts'));
      expect(tsFiles.length).toBeGreaterThan(0);
      const importsValibot = tsFiles.some((f) =>
        /from ['"]valibot['"]/.test(readText(join(generated, f)))
      );
      expect(importsValibot).toBe(true);

      // The test workspace sits inside this repo, so check valibot is installed in the workspace itself.
      expect(readJson<RootPackageJson>('package.json').dependencies?.['valibot']).toBeDefined();
      expect(exists('node_modules/valibot/package.json')).toBe(true);
      run(`npx tsc -p ${libDir}/tsconfig.lib.json --noEmit`);
    }, 900_000);
  });
});

/**
 * Creates a test workspace with create-nx-workspace and moves it to the Nx version under test.
 * @returns The directory where the test workspace was created
 */
function createTestProject() {
  const projectName = 'test-project';
  // Outside this repo, so Node never resolves packages from the plugin repo's node_modules.
  const projectDirectory = join(
    process.env['NX_ORVAL_E2E_DIR'] ?? join(tmpdir(), 'nx-orval-e2e'),
    projectName,
  );

  rmSync(projectDirectory, { recursive: true, force: true });
  mkdirSync(dirname(projectDirectory), { recursive: true });

  execSync(
    `npx --workspaces=false create-nx-workspace@${BOOTSTRAP_VERSION} ${projectName} --preset apps --nxCloud=skip --no-interactive --packageManager=npm --skipGit --aiAgents=none`,
    { cwd: dirname(projectDirectory), stdio: 'inherit', env: process.env }
  );

  const { version: installed } = JSON.parse(
    readFileSync(join(projectDirectory, 'node_modules/nx/package.json'), 'utf-8')
  ) as { version: string };
  if (installed !== NX_VERSION) {
    execSync(`npm install -D nx@${NX_VERSION} @nx/js@${NX_VERSION}`, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: process.env,
    });
  }
  console.log(`Created test project in "${projectDirectory}" (Nx ${NX_VERSION})`);

  return projectDirectory;
}
