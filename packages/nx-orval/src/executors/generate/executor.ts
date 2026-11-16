import type { ExecutorContext, PromiseExecutor } from '@nx/devkit';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ORVAL_CONFIG_NAMES } from '../../utils/orval-config';
import type { GenerateExecutorSchema } from './schema';

/** Walks up from Orval's entry file to its package root (Orval 7 does not export package.json). */
const findPackageJson = (from: string): string => {
  const candidate = join(from, 'package.json');
  if (existsSync(candidate)) {
    const { name } = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
    if (name === 'orval') return candidate;
  }
  const parent = dirname(from);
  if (parent === from) throw new Error('Could not locate the orval package root');
  return findPackageJson(parent);
};

/** Resolves the Orval CLI from the workspace, so the plugin never pins its own Orval version. */
export const resolveOrvalBin = (workspaceRoot: string): string => {
  const pkgPath = findPackageJson(dirname(require.resolve('orval', { paths: [workspaceRoot] })));
  const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof bin === 'string' ? bin : bin?.['orval'];
  if (!entry) throw new Error('Could not find the orval CLI in the installed orval package');
  return join(dirname(pkgPath), entry);
};

const resolveConfig = (options: GenerateExecutorSchema, context: ExecutorContext): string => {
  if (options.config) {
    const configPath = resolve(context.root, options.config);
    if (!existsSync(configPath)) throw new Error(`Orval config ${options.config} does not exist`);
    return configPath;
  }
  const root = context.projectName
    ? context.projectsConfigurations.projects[context.projectName]?.root
    : undefined;
  const found = ORVAL_CONFIG_NAMES.map((name) => join(context.root, root ?? '', name)).find(existsSync);
  if (!found) {
    throw new Error(`No orval.config.* found in ${root ?? context.root}; set the "config" option`);
  }
  return found;
};

export const buildArgs = (configPath: string, options: GenerateExecutorSchema): string[] => [
  '--config',
  configPath,
  ...(options.project ? ['--project', options.project] : []),
  ...(options.args ?? []),
];

const run = (bin: string, args: string[], cwd: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

const runExecutor: PromiseExecutor<GenerateExecutorSchema> = async (options, context) => {
  const configPath = resolveConfig(options, context);
  const bin = resolveOrvalBin(context.root);
  const code = await run(bin, buildArgs(configPath, options), dirname(configPath));
  return { success: code === 0 };
};

export default runExecutor;
