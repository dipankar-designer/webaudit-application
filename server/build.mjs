// Production build: bundles the API and the worker into dist/ (the shared TypeScript package is
// inlined; npm dependencies stay external) and copies the SQL migrations next to them.
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@wpcg/shared');

fs.rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts', 'src/worker.ts', 'src/db/migrate.ts', 'src/scripts/setPlan.ts', 'src/scripts/retention.ts', 'src/scanner/lighthouseRunner.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: [...external, 'lighthouse/*', 'chrome-launcher'],
  // Bundled ESM still needs require() for a few CommonJS dependencies.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
// Flatten entry points so `node dist/index.js` and `node dist/worker.js` work, and ship migrations.
fs.cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
fs.cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('server build complete');
