/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        location &&
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
      });
      console.log('[watch] build finished');
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['client/src/extension.ts', 'server/src/server.ts'],
  outdir: 'out',
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  allowOverwrite: true,
  // outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: production ? 'silent' : 'info',
  plugins: [
    /* add to the end of plugins array */
    esbuildProblemMatcherPlugin,
  ],
});

try {
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
