// Verifies the packed contents of a built package so a release cannot ship without its
// license and entry points, or with test files, TypeScript sources or dangling source maps.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = process.argv[2];
if (!packageDir) {
  console.error('Usage: node check-package.mjs <package directory>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

const normalize = (path) => path.replace(/^\.\//, '');

const required = [
  'package.json',
  'LICENSE',
  'README.md',
  manifest.main,
  manifest.types,
  manifest.generators,
  manifest.executors,
  'src/generators/api/files/sample/openapi.yaml',
]
  .filter(Boolean)
  .map(normalize);

const forbidden = [
  [/\.(spec|test)\.[cm]?[jt]s$/, 'test file'],
  [/\.tsbuildinfo$/, 'build info'],
  [/\.map$/, 'source map'],
  [/(?<!\.d)\.[cm]?ts$/, 'TypeScript source'],
];

const [{ files }] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
  }),
);
const packed = files.map((file) => file.path);

const missing = required.filter((path) => !packed.includes(path));
const unwanted = packed.flatMap((path) =>
  forbidden.filter(([pattern]) => pattern.test(path)).map(([, reason]) => `${path} (${reason})`),
);

console.log(`${manifest.name}@${manifest.version}: ${packed.length} files`);
if (missing.length > 0) console.error(`Missing from the package: ${missing.join(', ')}`);
if (unwanted.length > 0) console.error(`Must not be in the package: ${unwanted.join(', ')}`);
process.exit(missing.length + unwanted.length > 0 ? 1 : 0);
