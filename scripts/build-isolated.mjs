import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, unlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));

export async function buildIsolated(useOutput = () => {}, env = process.env) {
  // Vite compares the input's real path with the root. On Windows TEMP can contain a DOS alias.
  const parent = realpathSync.native(tmpdir());
  const copy = mkdtempSync(join(parent, 'calera-isolated-'));
  const metadata = join(source, 'src/generated/versionMetadata.json');
  const original = readFileSync(metadata);
  const links = [];
  try {
    for (const folder of ['src', 'public']) cpSync(join(source, folder), join(copy, folder), { recursive: true });
    for (const file of ['index.html', 'package.json', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js',
      'tsconfig.json', 'firebase-applet-config.json']) copyFileSync(join(source, file), join(copy, file));
    const installed = join(source, 'node_modules'), isolated = join(copy, 'node_modules');
    mkdirSync(isolated);
    for (const item of readdirSync(installed, { withFileTypes: true })) {
      if (item.name.startsWith('.') || (!item.isDirectory() && !item.isSymbolicLink())) continue;
      const target = join(isolated, item.name);
      symlinkSync(realpathSync.native(join(installed, item.name)), target, process.platform === 'win32' ? 'junction' : 'dir');
      links.push(target);
    }
    const result = spawnSync(process.execPath, [join(installed, 'vite/bin/vite.js'), 'build'], {
      cwd: copy, env, stdio: 'inherit', windowsHide: true
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
    const dist = join(copy, 'dist');
    assert.equal(JSON.parse(readFileSync(join(dist, 'version-metadata.json'), 'utf8')).bundleCompleted, true);
    assert.ok(existsSync(join(dist, 'sw.js')) && existsSync(join(dist, 'manifest.webmanifest')));
    return await useOutput(dist, copy);
  } finally {
    assert.equal(dirname(realpathSync.native(copy)), parent);
    assert.match(basename(copy), /^calera-isolated-/);
    for (const link of links) unlinkSync(link);
    rmSync(copy, { recursive: true, maxRetries: 10, retryDelay: 150 });
    assert.deepEqual(readFileSync(metadata), original, 'Los metadatos versionados cambiaron durante la compilación.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { ...process.env };
  delete env.VITE_CALERA_AUTH_EMULATOR;
  delete env.VITE_CALERA_DEMO_PROJECT;
  await buildIsolated(() => console.log('Build aislado completado. Se conservaron los metadatos versionados.'), env);
}
