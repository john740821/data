import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DIR, USER_AGENT } from '../config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cachePath(key, ext) {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
  return path.join(DIR.raw, `${hash}${ext}`)
}

/**
 * ดึง URL พร้อม cache ลงดิสก์ + retry แบบ exponential backoff
 * คืนค่าเป็น Buffer เสมอ (ให้ผู้เรียกตัดสินใจเรื่อง encoding เอง)
 *
 * @param {string} url
 * @param {{method?:string, body?:string, headers?:object, label?:string, refresh?:boolean, retries?:number, timeoutMs?:number}} opts
 */
export async function fetchCached(url, opts = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    label = '',
    refresh = false,
    retries = 3,
    timeoutMs = 180_000,
  } = opts

  fs.mkdirSync(DIR.raw, { recursive: true })
  const key = `${method} ${url}\n${body ?? ''}`
  const file = cachePath(key, '.bin')
  const metaFile = cachePath(key, '.meta.json')

  if (!refresh && fs.existsSync(file)) {
    return fs.readFileSync(file)
  }

  const reqHeaders = { 'User-Agent': USER_AGENT, ...headers }
  if (method !== 'GET' && body !== null) {
    // ThaiRSC ตอบ HTTP 411 ถ้าไม่มี Content-Length แม้ body จะว่าง
    reqHeaders['Content-Length'] = String(Buffer.byteLength(body))
  }

  let lastErr
  let rateLimited = false
  let retryAfterMs = 0

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 429 ต้องรอนานกว่าปกติมาก — backoff แบบ error ทั่วไป (1/2/4 วิ) ไม่พอ
      // Open-Meteo จำกัด burst จริงจัง ถ้ารีบยิงซ้ำจะโดนปฏิเสธซ้ำจนหมด retry
      const wait = rateLimited
        ? Math.max(retryAfterMs, 30_000 * 2 ** (attempt - 1))
        : 1000 * 2 ** (attempt - 1)
      console.warn(
        `  retry ${attempt}/${retries} after ${Math.round(wait / 1000)}s${rateLimited ? ' (rate limited)' : ''} — ${label || url}`,
      )
      await sleep(wait)
    }
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      let res
      try {
        res = await fetch(url, {
          method,
          headers: reqHeaders,
          body: method === 'GET' ? undefined : body,
          signal: ac.signal,
          redirect: 'follow',
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        if (res.status === 429) {
          rateLimited = true
          const header = res.headers.get('retry-after')
          const seconds = header ? Number(header) : NaN
          retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : 0
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) throw new Error('empty response body')
      fs.writeFileSync(file, buf)
      fs.writeFileSync(
        metaFile,
        JSON.stringify({ url, method, body, label, bytes: buf.length, fetchedAt: new Date().toISOString() }, null, 2),
      )
      return buf
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${label || url} — ${lastErr?.message}`)
}

/** POST แบบ x-www-form-urlencoded (รูปแบบที่ ThaiRSC ใช้) */
export async function postForm(url, params = {}, opts = {}) {
  const body = new URLSearchParams(params).toString()
  return fetchCached(url, {
    ...opts,
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
  })
}

export async function fetchJson(url, opts = {}) {
  const buf = await fetchCached(url, opts)
  return JSON.parse(buf.toString('utf8'))
}

export async function postFormJson(url, params = {}, opts = {}) {
  const buf = await postForm(url, params, opts)
  return JSON.parse(buf.toString('utf8'))
}

export { sleep }
