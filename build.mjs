import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(root, 'src/main.js')],
  outfile: path.join(root, 'main.js'),
  bundle: true,
  external: ['obsidian', 'electron'],
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
});
