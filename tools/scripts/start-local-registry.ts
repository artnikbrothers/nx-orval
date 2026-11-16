/**
 * This script starts a local registry for e2e testing purposes.
 * It is meant to be called in jest's globalSetup.
 */

/// <reference path="registry.d.ts" />

import { workspaceRoot } from '@nx/devkit';
import { startLocalRegistry } from '@nx/js/plugins/jest/local-registry';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releasePublish, releaseVersion } from 'nx/release';

type Manifest = Record<string, unknown> & { publishConfig?: Record<string, unknown> };

/**
 * Removes the provenance request from a built manifest. npm only signs provenance
 * from a CI identity provider, which a local registry run does not have.
 */
const dropProvenance = (manifestPath: string): void => {
  const { publishConfig = {}, ...manifest }: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const withoutProvenance = Object.fromEntries(
    Object.entries(publishConfig).filter(([key]) => key !== 'provenance'),
  );
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, publishConfig: withoutProvenance }, null, 2)}\n`);
};

export default async () => {
  // local registry target to run
  const localRegistryTarget = '@nx-orval/source:local-registry';
  // storage folder for the local registry
  const storage = './tmp/local-registry/storage';

  global.stopLocalRegistry = await startLocalRegistry({
    localRegistryTarget,
    storage,
    verbose: false,
    // loopback only: Verdaccio must never be reachable from the network
    listenAddress: '127.0.0.1',
  });

  await releaseVersion({
    specifier: '0.0.0-e2e',
    stageChanges: false,
    gitCommit: false,
    gitTag: false,
    // nx.json turns on pushing for real releases; the e2e version bump must stay local
    gitPush: false,
    firstRelease: true,
    versionActionsOptionsOverrides: {
      skipLockFileUpdate: true
    }
  });
  dropProvenance(join(workspaceRoot, 'dist/packages/nx-orval/package.json'));
  await releasePublish({
    tag: 'e2e',
    firstRelease: true
  });
};
