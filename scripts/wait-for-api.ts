const apiBase = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 4321}`;
const healthUrl = new URL('/api/health', apiBase).toString();
const startedAt = Date.now();
const timeoutMs = Number(process.env.DEV_API_WAIT_TIMEOUT_MS || 60_000);

process.stdout.write(`waiting for lvl API at ${healthUrl}\n`);

while (Date.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(healthUrl);
    if (response.ok) {
      process.stdout.write('lvl API is ready; starting web dev server\n');
      process.exit(0);
    }
  } catch {
    // API is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

process.stderr.write(`timed out waiting for lvl API at ${healthUrl}\n`);
process.exit(1);

export {};
