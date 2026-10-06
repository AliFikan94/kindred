// Copies the ABIs the keeper needs out of the Foundry build (run `forge build` in ../contracts first).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'contracts', 'out');
const dest = join(here, '..', 'src', 'abi');
mkdirSync(dest, { recursive: true });

for (const name of ['ScheduleVault', 'StakedScheduleVault', 'ScheduleFactory']) {
  const artifact = JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), 'utf8'));
  writeFileSync(join(dest, `${name}.json`), JSON.stringify(artifact.abi, null, 2) + '\n');
  console.log(`abi/${name}.json  (${artifact.abi.length} entries)`);
}
