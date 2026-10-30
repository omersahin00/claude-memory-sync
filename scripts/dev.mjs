// Development: Vite dev server for the window, then Electron pointed at it.  npm run dev
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');

const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)) });
await server.listen();
const url = server.resolvedUrls.local[0];
const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
