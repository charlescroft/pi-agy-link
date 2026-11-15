import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shimsDir = join(root, 'src', 'pi', 'dsh-shims')

mkdirSync(join(root, 'dist'), { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'pi', 'index.ts')],
  outfile: join(root, 'dist', 'pi-extension.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  external: [
    '@earendil-works/*',
    'node:*',
  ],
  alias: {
    '@deepseek-ai/cordis': join(shimsDir, 'cordis.ts'),
    '@deepseek-ai/dsh-llm': join(shimsDir, 'dsh-llm.ts'),
    '@deepseek-ai/dsh-tools': join(shimsDir, 'dsh-tools.ts'),
    '@deepseek-ai/dsh-commands': join(shimsDir, 'dsh-commands.ts'),
  },
})

try {
  cpSync(join(root, 'src', 'host', 'bridge.mjs'), join(root, 'dist', 'bridge.mjs'))
} catch {}

console.log('Built dist/pi-extension.js successfully')
