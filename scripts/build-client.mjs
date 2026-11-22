// クライアント(hono/jsx/dom)を dist/client/assets へバンドルし、CSSをコピーする。
import { build } from 'esbuild'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist/client/assets')

await rm(path.join(root, 'dist/client'), { recursive: true, force: true })
await mkdir(out, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src/client/entry.tsx')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx/dom',
  tsconfig: path.join(root, 'tsconfig.client.json'),
  legalComments: 'none',
  logLevel: 'info',
})
await copyFile(path.join(root, 'src/styles/app.css'), path.join(out, 'app.css'))
console.log('client build done')
