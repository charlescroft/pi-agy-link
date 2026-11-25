import { build } from 'esbuild'
import { chmodSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shimsDir = join(root, 'src', 'pi', 'dsh-shims')

mkdirSync(join(root, 'dist'), { recursive: true })

await Promise.all([
  build({
    entryPoints: [join(root, 'src', 'pi', 'index.ts')],
    outfile: join(root, 'dist', 'pi-extension.js'),
    bundle: true,
    minify: true,
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
  }),
  build({
    entryPoints: [join(root, 'src', 'host', 'mcp-sanitize-shim.ts')],
    outfile: join(root, 'dist', 'mcp-sanitize.mjs'),
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    external: ['node:*'],
  }),
])

try {
  const bridgeOut = join(root, 'dist', 'bridge.mjs')
  cpSync(join(root, 'src', 'host', 'bridge.mjs'), bridgeOut)
  chmodSync(bridgeOut, 0o755)
  chmodSync(join(root, 'dist', 'mcp-sanitize.mjs'), 0o755)
} catch {}

console.log('Built dist/pi-extension.js, dist/bridge.mjs, and dist/mcp-sanitize.mjs successfully')
