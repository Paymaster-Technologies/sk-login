import { defineConfig } from 'tsup';

// The widget is built as ESM/CJS (for bundlers) and as an IIFE with the
// `SkLoginWidget` global (for <script src>). The CSS is embedded in the JS
// as a string and injected into a <style> on the first mount (see src/styles.ts).
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    platform: 'browser',
    target: 'es2020',
  },
  {
    entry: { 'sk-login-widget': 'src/index.ts' },
    format: ['iife'],
    globalName: 'SkLoginWidget',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true,
  },
]);
