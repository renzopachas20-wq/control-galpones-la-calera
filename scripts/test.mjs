import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const tests = ['src', 'server'].flatMap(folder =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts') && !entry.name.endsWith('.emulator.test.ts'))
    .map(entry => join(entry.parentPath, entry.name))
).sort();

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
