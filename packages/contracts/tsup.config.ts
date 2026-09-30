import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'fixtures/index': 'src/fixtures/index.ts' },
  format: ['esm', 'cjs'],
  // tsup's dts step sets the deprecated `baseUrl`; TS 6 errors on it unless silenced.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
