/**
 * dsh-opencodego-quota — HOST half.
 *
 * Cordis plugin for a DeepSeek Harness web profile. Serves the official
 * OpenCode Zen Go usage endpoint to the browser half at
 * `GET /opencodego-quota/api`.
 *
 * The API key is resolved, in order, from:
 *   1. the DSH credentials seam — `OPENCODE_GO_API_KEY`
 *      (`~/.dsh/.credentials.yaml`, the same key the provider config
 *      `llm-pi-ai.providers.opencode-go.apiKeyEnv` points at);
 *   2. the `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` process environment;
 *   3. the OpenCode CLI auth file `~/.local/share/opencode/auth.json`
 *      (`opencode-go` entry, `type: "api"`; fallback `opencode`).
 *
 * The key is only ever sent to the official endpoint
 * `https://opencode.ai/zen/go/v1/usage` over HTTPS (Bearer + x-api-key).
 *
 * Diagnostics mirror the dsh-usage-plugin pattern: every activation step is
 * flushed to `<session workspace>/opencodego-quota-boot.log` so a missing
 * route is visible without app logs.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Official OpenCode Zen Go usage endpoint (undocumented but stable). */
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
/** Fetch timeout in milliseconds. */
const TIMEOUT_MS = 15000
/**
 * Go plan per-window dollar quotas, used only to convert the endpoint's
 * percent into a "$ used / $ limit" readout (the endpoint returns percent
 * only). Mirrors the official dashboard: 滚动 5 小时 = $12 / 周 = $30 / 月 = $60.
 */
const WINDOW_LIMITS = { rolling: 12, weekly: 30, monthly: 60 }

export default {
  inject: ['fs', 'webServer', 'credentials'],
  apply(ctx) {
    const diag = { ok: true, steps: [], error: null }
    const push = (s) => {
      try { diag.steps.push(String(s)) } catch (e) { /* noop */ }
    }
    const flushDiag = () => {
      try {
        const fs = ctx.get('fs')
        if (fs && typeof fs.resolve === 'function' && typeof fs.writeText === 'function') {
          fs.resolve('opencodego-quota-boot.log')
            .then((target) => fs.writeText(target, JSON.stringify({ time: Date.now(), ...diag }, null, 2)))
            .catch(() => { /* boot log best-effort */ })
        }
      } catch (e) { /* noop */ }
    }

    try {
      push('apply-start')

      const msg = (e) => String((e && e.message) || e)

      /** Resolve the OpenCode Go API key from the configured sources. */
      async function resolveKey() {
        const credentials = ctx.get('credentials')
        if (credentials && typeof credentials.resolve === 'function') {
          try {
            const hit = await credentials.resolve('OPENCODE_GO_API_KEY')
            if (hit && hit.value) return { key: String(hit.value), source: 'credentials' }
          } catch (e) { /* fall through */ }
        }
        const envKey = process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY
        if (envKey) return { key: envKey, source: 'env' }
        const authCandidates = [
          join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
          join(homedir(), '.config', 'opencode', 'auth.json'),
        ]
        for (const authPath of authCandidates) {
          try {
            const parsed = JSON.parse(await readFile(authPath, 'utf8'))
            const entry = (parsed && (parsed['opencode-go'] || parsed['opencode'])) || {}
            if (entry && typeof entry.key === 'string' && entry.key.length > 0) {
              return { key: entry.key, source: 'auth.json' }
            }
          } catch (e) { /* try next */ }
        }
        return null
      }

      /**
       * Fetch and normalize quota data.
       * Expected official response shape:
       *   { usage: { rolling:  { status:'ok', percent:18, resetsAt:'…' },
       *              weekly:   { status:'ok', percent:34, resetsAt:'…' },
       *              monthly:  { status:'ok', percent:35, resetsAt:'…' } } }
       * An older { used, limit } numeric pair shape is tolerated per window.
       */
      async function fetchQuota() {
        const resolved = await resolveKey()
        if (!resolved) {
          return { ok: false, error: '未找到 OpenCode Go API Key（请确认已配置 OPENCODE_GO_API_KEY 凭据）' }
        }
        let res
        try {
          res = await fetch(USAGE_URL, {
            headers: {
              Authorization: 'Bearer ' + resolved.key,
              'x-api-key': resolved.key,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch (e) {
          return { ok: false, error: '访问 usage 接口失败：' + msg(e) }
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return {
            ok: false,
            error: `usage 接口返回 HTTP ${res.status}${text ? '：' + text.slice(0, 200) : ''}`,
          }
        }
        const body = await res.json().catch(() => null)
        if (!body || typeof body !== 'object' || !body.usage || typeof body.usage !== 'object') {
          return { ok: false, error: 'usage 接口响应格式异常' }
        }
        const usage = body.usage
        const windows = {}
        for (const [win, limit] of Object.entries(WINDOW_LIMITS)) {
          const w = usage[win]
          if (!w || typeof w !== 'object') {
            windows[win] = { available: false, limit, status: 'missing', percent: null, usedDollars: null, resetsAt: null }
            continue
          }
          let percent = null
          if (typeof w.percent === 'number' && Number.isFinite(w.percent)) {
            percent = w.percent
          } else if (typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0) {
            percent = Math.min(100, Math.round((w.used / w.limit) * 100))
          }
          windows[win] = {
            available: true,
            status: w.status ?? (percent === null ? 'unknown' : 'ok'),
            percent,
            usedDollars: percent === null ? null : Math.round((percent / 100) * limit * 100) / 100,
            limit,
            resetsAt: w.resetsAt ?? null,
          }
        }
        const anyOk = Object.values(windows).some((w) => w.available && w.status === 'ok')
        if (!anyOk) return { ok: false, error: 'usage 接口未返回可用的额度窗口数据' }
        return { ok: true, fetchedAt: Date.now(), keySource: resolved.source, windows }
      }

      const webServer = ctx.get('webServer')
      push('webServer=' + (webServer ? 'present' : 'undefined'))
      if (webServer && typeof webServer.register === 'function') {
        try {
          webServer.register({
            kind: 'exact',
            path: '/opencodego-quota/api',
            handler: async (req, res) => {
              let payload
              try {
                payload = await fetchQuota()
              } catch (e) {
                payload = { ok: false, error: msg(e) }
              }
              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
              })
              res.end(JSON.stringify(payload))
            },
          })
          push('route-registered')
        } catch (e) {
          push('route-register-threw: ' + (e && e.stack ? e.stack : msg(e)))
        }
      } else {
        push('route-not-registered (no webServer)')
      }

      push('apply-end')
      diag.ok = true
    } catch (e) {
      diag.ok = false
      diag.error = (e && e.stack) ? e.stack : String(e)
    }
    flushDiag()
  },
}