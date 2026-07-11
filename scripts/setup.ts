import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const envExample = path.join(root, '.env.example');
const envLocal = path.join(root, '.env.local');
const localDirs = ['data', 'artifacts', 'report'];

async function main() {
  await ensureEnvLocal();
  for (const dir of localDirs) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  console.log('lvl setup complete');
  console.log('- .env.local ready');
  console.log(`- local dirs ready: ${localDirs.join(', ')}`);
}

async function ensureEnvLocal() {
  try {
    await fs.access(envLocal);
  } catch {
    await fs.copyFile(envExample, envLocal);
    console.log('created .env.local from .env.example');
  }
}

await main();
