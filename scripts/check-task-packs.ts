import { checkTaskPacks } from '../src/server/taskRegistry.js';

const report = await checkTaskPacks();

console.log(`Task pack config: ${report.configPath}`);

if (!report.configured) {
  console.log('No data/task-packs.json file found. Using the built-in chess match only.');
  process.exit(0);
}

console.log(`Linked puzzle tasks: ${report.tasks.length}`);
for (const task of report.tasks) {
  console.log(`- ${task.id}: ${task.title} (${task.difficulty}, ${task.objective.maxPlies ?? task.maxSteps} plies)`);
}

if (report.errors.length) {
  console.error('\nTask pack check failed:');
  for (const error of report.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Task pack check passed.');
