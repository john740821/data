/**
 * ทำงานกับวันที่แบบ 'YYYY-MM-DD' ล้วน ๆ (ไม่มี timezone) เพื่อเลี่ยงปัญหา UTC offset
 */

const pad = (n) => String(n).padStart(2, '0')

/**
 * แปลงวันที่จาก RTDDI ให้เป็น ISO 'YYYY-MM-DD'
 * รองรับ 'd/m/yyyy' (ปี 2565-2567) และ 'yyyy-mm-dd' (ปี 2568-2569)
 * ค.ศ. เท่านั้น — ไฟล์ต้นทางใช้ ค.ศ. ในคอลัมน์วันที่ทุกปีที่ตรวจสอบแล้ว
 */
export function normalizeDate(raw, format) {
  if (!raw) return null
  const s = String(raw).trim()
  if (s === '') return null

  if (format === 'iso' || /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
    if (!m) return null
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
  }

  // d/m/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  let year = Number(m[3])
  // เผื่อกรณีไฟล์บางแถวใช้ พ.ศ.
  if (year > 2400) year -= 543
  const month = Number(m[2])
  const day = Number(m[1])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * แปลงเลข serial ของ Excel เป็น ISO date
 * ชุด MOT ปี 2567/2568 เก็บวันที่เป็นตัวเลขล้วน เช่น 45292 = 2024-01-01
 * epoch ของ Excel คือ 1899-12-30 (เผื่อบั๊กปีอธิกสุรทิน 1900 ที่ Excel มีมาแต่ไหนแต่ไร)
 */
export function excelSerialToIso(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num < 1 || num > 60000) return null
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(num) * 86_400_000).toISOString().slice(0, 10)
}

/**
 * เดารูปแบบวันที่จากข้อมูลจริง แทนการ hard-code ตามปี
 * ชุด MOT ใช้คนละรูปแบบกันทุกปี (M/D/YYYY, D/M/YYYY, Excel serial) และไม่มีอะไรการันตีว่าปีหน้าจะไม่เปลี่ยนอีก
 *
 * กติกา: ตัวเลขล้วน -> 'excel'
 *        ถ้าส่วนแรกเคยเกิน 12 -> 'dmy' (เป็นวันแน่นอน)
 *        ถ้าส่วนสองเคยเกิน 12 -> 'mdy'
 *        ถ้าไม่เกิน 12 ทั้งคู่ -> แยกไม่ออก คืน null ให้ผู้เรียกจัดการ (อย่าเดามั่ว)
 * @returns {'excel'|'iso'|'dmy'|'mdy'|null}
 */
export function detectDateFormat(values) {
  let numeric = 0
  let isoLike = 0
  let total = 0
  let maxFirst = 0
  let maxSecond = 0

  for (const raw of values) {
    if (raw === null || raw === undefined) continue
    const s = String(raw).trim()
    if (s === '') continue
    total++
    if (/^\d+(\.\d+)?$/.test(s)) {
      numeric++
      continue
    }
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
      isoLike++
      continue
    }
    const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
    if (m) {
      maxFirst = Math.max(maxFirst, Number(m[1]))
      maxSecond = Math.max(maxSecond, Number(m[2]))
    }
  }

  if (total === 0) return null
  if (numeric / total > 0.9) return 'excel'
  if (isoLike / total > 0.9) return 'iso'
  if (maxFirst > 12) return 'dmy'
  if (maxSecond > 12) return 'mdy'
  return null
}

/** แปลงวันที่ตามรูปแบบที่ detectDateFormat คืนมา */
export function parseDateByFormat(raw, format) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (s === '') return null

  if (format === 'excel') return excelSerialToIso(s)
  if (format === 'iso') return normalizeDate(s, 'iso')

  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (!m) return null
  const first = Number(m[1])
  const second = Number(m[2])
  let year = Number(m[3])
  if (year > 2400) year -= 543

  const day = format === 'dmy' ? first : second
  const month = format === 'dmy' ? second : first
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

/** ไล่วันที่จาก start ถึง end (รวมปลายทาง) คืน array ของ 'YYYY-MM-DD' */
export function dateRange(start, end) {
  const out = []
  const d = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime()
  const db = new Date(`${b}T00:00:00Z`).getTime()
  return Math.round((db - da) / 86_400_000)
}

/** 0 = อาทิตย์ ... 6 = เสาร์ */
export function dayOfWeek(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

export function dayOfYear(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.floor((d.getTime() - start) / 86_400_000) + 1
}

export const yearOf = (iso) => Number(iso.slice(0, 4))
export const monthOf = (iso) => Number(iso.slice(5, 7))
export const dayOf = (iso) => Number(iso.slice(8, 10))

/**
 * เช็คว่าวันที่อยู่ในช่วงเทศกาลที่กำหนดเป็น [เดือน, วัน] หรือไม่
 * รองรับช่วงที่คร่อมปีใหม่ (เช่น 29 ธ.ค. - 4 ม.ค.)
 */
export function inMonthDayWindow(iso, window) {
  const m = monthOf(iso)
  const d = dayOf(iso)
  const [fm, fd] = window.from
  const [tm, td] = window.to
  const cur = m * 100 + d
  const from = fm * 100 + fd
  const to = tm * 100 + td
  return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to
}
