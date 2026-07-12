import { checkLinkedHarnesses } from '../src/server/harnessRegistry.js';

const report = await checkLinkedHarnesses();

console.log(`Harness config: ${report.configPath}`);

if (!report.configured) {
  console.log('No data/harness-adapters.json file found. Using the built-in harness only.');
  process.exit(0);
}

console.log(`Linked harnesses: ${report.harnesses.length}`);
for (const harness of report.harnesses) {
  console.log(`- ${harness.id}: ${harness.name} (${harness.adapter?.modulePath ?? 'no module'})`);
}

if (report.errors.length) {
  console.error('\nHarness check failed:');
  for (const error of report.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Harness check passed.');
