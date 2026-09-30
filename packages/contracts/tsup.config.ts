import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'fixtures/index': 'src/fixtures/index.ts' },
  format: ['esm', 'cjs'],
  // tsup's dts step sets the deprecated `baseUrl`; TS 6 errors on it unless silenced.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  // Never wipe dist/ before building: the API (nest --watch) and the web app read it while a build (or the
  // dev watcher) runs, and an emptied dist/ briefly has no .d.ts → TS7016 in the API. Files are overwritten
  // in place instead. `pnpm build:clean` does a from-scratch build (CI, fresh clones).
  clean: false,
  target: 'es2022',
});
