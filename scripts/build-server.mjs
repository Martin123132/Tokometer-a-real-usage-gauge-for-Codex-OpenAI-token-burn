import { build } from 'esbuild'

await build({
  bundle: true,
  entryPoints: ['server/usage.ts'],
  external: ['electron'],
  format: 'cjs',
  logLevel: 'info',
  outfile: 'dist-server/usage.cjs',
  platform: 'node',
  sourcemap: false,
  target: ['node20'],
})
