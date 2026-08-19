// Probe the official OpenCode Zen Go usage endpoint with the configured key.
// Keep this file only for development validation (not shipped).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

async function main() {
  const credFile = join(homedir(), '.dsh', '.credentials.yaml')
  let key = null
  let source = null
  try {
    const text = readFileSync(credFile, 'utf8')
    const m = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/))
      .filter(Boolean)
      .find((m) => m[1] === 'OPENCODE_GO_API_KEY')
    if (m) {
      key = m[2].replace(/^["']|["']$/g, '')
      source = 'credentials.yaml'
    }
  } catch (e) {
    console.log('read credentials failed:', e.message)
  }
  if (!key) {
    console.log('RESULT: no OPENCODE_GO_API_KEY found')
    return
  }
  console.log('key source:', source, '| key prefix:', key.slice(0, 6) + '…', '| length:', key.length)

  // env fallbacks
  if (process.env.OPENCODE_GO_API_KEY) console.log('note: OPENCODE_GO_API_KEY env also present')
  if (process.env.OPENCODE_API_KEY) console.log('note: OPENCODE_API_KEY env also present')

  const url = 'https://opencode.ai/zen/go/v1/usage'
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + key,
        'x-api-key': key,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    console.log('HTTP', res.status, 'in', Date.now() - t0 + 'ms')
    console.log('BODY:', text.slice(0, 2500))
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      console.log('body is not JSON')
    }
    if (parsed && parsed.usage) {
      const u = parsed.usage
      for (const w of ['rolling', 'weekly', 'monthly']) {
        const win = u[w]
        if (win) {
          console.log(`${w}: status=${win.status} percent=${win.percent} resetsAt=${win.resetsAt}`)
        } else {
          console.log(`${w}: <missing>`)
        }
      }
    }
  } catch (e) {
    console.log('FETCH ERR:', e.message)
  }
}

main()