// Smoke test for the host half: stub the Cordis ctx (credentials/webServer/fs),
// run apply(), and exercise the registered route against the REAL endpoint.
// Run: node scripts/smoke.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

// bits of helpers
function readCredentialsYaml() {
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = text
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .map((l) => l.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)).filter(Boolean)
      .find((m) => m[1] === 'OPENCODE_GO_API_KEY')
    return m ? m[2].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}

let handler = null
const applied = {}

const fakeCtx = {
  get(name) {
    if (name === 'credentials') {
      return {
        async resolve(keyName) {
          if (keyName !== 'OPENCODE_GO_API_KEY') return null
          const key = readCredentialsYaml()
          return key ? { value: key } : null
        },
      }
    }
    if (name === 'webServer') {
      return {
        register(entry) {
          if (entry && entry.path === '/opencodego-quota/api' && typeof entry.handler === 'function') {
            handler = entry.handler
          }
          applied.register = entry
        },
      }
    }
    if (name === 'fs') {
      return {
        async resolve(p) { return p },
        async writeText() {},
      }
    }
    return undefined
  },
}

console.log('module default keys:', Object.keys(plugin.default))
console.log('inject:', JSON.stringify(plugin.default.inject))

plugin.default.apply(fakeCtx)
console.log('route registered:', applied.register ? applied.register.path : '(none)')

if (!handler) {
  console.log('SMOKE FAIL: handler not registered')
  process.exit(1)
}

function fakeRes() {
  const chunks = []
  return {
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(payload) { chunks.push(String(payload)) },
    get body() { return chunks.join('') },
    get status() { return this._status },
  }
}

const res = fakeRes()
await handler({}, res)
console.log('status:', res.status, '| cache-control:', res._headers && res._headers['Cache-Control'])
const parsed = JSON.parse(res.body)
console.log('body JSON keys:', Object.keys(parsed))
if (parsed.ok) {
  console.log('keySource:', parsed.keySource, '| fetchedAt:', new Date(parsed.fetchedAt).toLocaleString())
  for (const [k, w] of Object.entries(parsed.windows)) {
    console.log(`  ${k}: available=${w.available} status=${w.status} percent=${w.percent} used=${w.usedDollars} limit=${w.limit} resetsAt=${w.resetsAt}`)
  }
} else {
  console.log('SMOKE FAIL: response ok=false ->', parsed.error)
  process.exit(1)
}
console.log('SMOKE OK')