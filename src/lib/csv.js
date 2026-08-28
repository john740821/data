/**
 * ถอดรหัส buffer เป็น string
 * ไฟล์ RTDDI ปี 2565/2566 เป็น TIS-620 (windows-874) ส่วนปีหลังเป็น UTF-8 + BOM
 * ตรวจด้วยการลอง decode UTF-8 แบบ fatal ก่อน ถ้าพังค่อยตกไป windows-874
 */
export function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-874').decode(buf)
  }
}

/** แยกหนึ่งบรรทัด CSV โดยรองรับ quoted field และ "" ที่ escape ไว้ */
function splitLine(line, delimiter) {
  const out = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

/**
 * แยกข้อความ CSV เป็นบรรทัดโดยเคารพ newline ที่อยู่ใน quoted field
 */
function splitRecords(text) {
  const records = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      cur += ch
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      records.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.length > 0) records.push(cur)
  return records
}

/**
 * แปลง CSV เป็น array ของ object
 * @param {Buffer|string} input
 * @returns {{headers: string[], rows: object[]}}
 */
export function parseCsv(input, { delimiter = ',' } = {}) {
  const text = Buffer.isBuffer(input) ? decodeBuffer(input) : input
  const records = splitRecords(text).filter((r) => r.trim().length > 0)
  if (records.length === 0) return { headers: [], rows: [] }

  const headers = splitLine(records[0], delimiter).map((h) => h.replace(/^﻿/, '').trim())
  const rows = new Array(records.length - 1)
  for (let i = 1; i < records.length; i++) {
    const cells = splitLine(records[i], delimiter)
    const obj = {}
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (cells[c] ?? '').trim()
    rows[i - 1] = obj
  }
  return { headers, rows }
}

/** แปลง "1,384.315" หรือ "699,971,304" เป็นตัวเลข คืน null ถ้าไม่ใช่ตัวเลข */
export function parseNumber(value) {
  if (value === null || value === undefined) return null
  const s = String(value).replace(/,/g, '').replace(/%/g, '').trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function escapeCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** เขียน array ของ object เป็น CSV (UTF-8 พร้อม BOM ให้ Excel อ่านภาษาไทยได้) */
export function toCsv(rows, headers) {
  const cols = headers ?? (rows.length > 0 ? Object.keys(rows[0]) : [])
  const lines = [cols.map(escapeCell).join(',')]
  for (const row of rows) lines.push(cols.map((c) => escapeCell(row[c])).join(','))
  return '﻿' + lines.join('\n') + '\n'
}
