import { HOLIDAY_ICS, FESTIVAL_WINDOWS } from '../config.js'
import { fetchCached } from '../lib/http.js'
import { addDays, dayOfWeek, daysBetween, inMonthDayWindow } from '../lib/dates.js'

/**
 * แกะไฟล์ ICS แบบง่าย ๆ พอสำหรับปฏิทินวันหยุดของ Google
 * ต้องจัดการ line folding ของมาตรฐาน ICS ด้วย (บรรทัดที่ขึ้นต้นด้วยช่องว่างคือส่วนต่อของบรรทัดก่อนหน้า)
 */
export function parseIcsHolidays(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const holidays = new Map()

  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const dateMatch = block.match(/DTSTART(?:;VALUE=DATE)?:(\d{4})(\d{2})(\d{2})/)
    if (!dateMatch) continue
    const summaryMatch = block.match(/\nSUMMARY:(.*)/)
    const descMatch = block.match(/\nDESCRIPTION:(.*)/)
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    const name = (summaryMatch?.[1] ?? '').trim()
    const description = (descMatch?.[1] ?? '').trim()

    // ปฏิทินนี้รวมวันสำคัญที่ "ไม่ใช่วันหยุดราชการ" มาด้วย (คริสต์มาสอีฟ, ตรุษจีน, วาเลนไทน์)
    // ซึ่งไม่ได้ทำให้คนหยุดงานหรือเดินทางกลับบ้าน จึงต้องแยกออกจากวันหยุดนักขัตฤกษ์จริง
    const isPublic = /วันหยุดนักขัตฤกษ์|ชดเชย/.test(description) || /ชดเชย/.test(name)

    const existing = holidays.get(date)
    if (!existing) {
      holidays.set(date, { name, description, isPublic })
    } else if (isPublic && !existing.isPublic) {
      // วันเดียวกันอาจมีหลาย event — ให้วันหยุดราชการชนะ
      holidays.set(date, { name, description, isPublic })
    }
  }

  return holidays
}

export async function fetchHolidays() {
  const buf = await fetchCached(HOLIDAY_ICS, { label: 'holidays:ics' })
  const holidays = parseIcsHolidays(buf.toString('utf8'))
  if (holidays.size === 0) {
    throw new Error('แกะวันหยุดจากไฟล์ ICS ไม่ได้เลย — รูปแบบไฟล์อาจเปลี่ยน')
  }
  return holidays
}

/**
 * สร้าง feature เกี่ยวกับเทศกาล/วันหยุดสำหรับทุกวันในช่วง
 *
 * "7 วันอันตราย" คือช่วงรณรงค์ที่ ศปถ. ใช้จริงในเทศกาลปีใหม่และสงกรานต์
 * ซึ่งเป็นช่วงที่อุบัติเหตุพุ่งสูงทุกปี จึงแยกเป็น feature ต่างหากจากวันหยุดทั่วไป
 *
 * @param {string[]} dates
 * @param {Map<string,string>} holidays
 */
export function buildHolidayFeatures(dates, holidays) {
  const isPublicHoliday = (d) => holidays.get(d)?.isPublic === true
  const isWeekendDay = (d) => [0, 6].includes(dayOfWeek(d))
  /** วันที่คนไม่ต้องไปทำงาน = วันหยุดราชการ หรือ เสาร์อาทิตย์ */
  const isDayOff = (d) => isPublicHoliday(d) || isWeekendDay(d)

  // นับเฉพาะวันหยุดราชการ ไม่นับวันสำคัญอย่างคริสต์มาสอีฟหรือตรุษจีน
  // เพราะวันพวกนั้นคนยังไปทำงานตามปกติ รูปแบบการเดินทางจึงไม่เปลี่ยน
  const publicHolidayDates = [...holidays.entries()]
    .filter(([, info]) => info.isPublic)
    .map(([date]) => date)
    .sort()

  const findNext = (date) => {
    for (const h of publicHolidayDates) if (h > date) return h
    return null
  }
  const findPrev = (date) => {
    let prev = null
    for (const h of publicHolidayDates) {
      if (h < date) prev = h
      else break
    }
    return prev
  }

  /**
   * ความยาวของช่วงวันหยุดต่อเนื่องที่ "วันนี้" อยู่ในนั้น
   * ถ้าวันนี้ต้องไปทำงาน ถือว่าไม่อยู่ในช่วงวันหยุดเลย คืน 0
   */
  const dayOffRunLength = (date) => {
    if (!isDayOff(date)) return 0
    let length = 1
    for (let k = 1; k <= 10; k++) {
      if (!isDayOff(addDays(date, -k))) break
      length++
    }
    for (let k = 1; k <= 10; k++) {
      if (!isDayOff(addDays(date, k))) break
      length++
    }
    return length
  }

  const out = new Map()
  for (const date of dates) {
    const info = holidays.get(date)
    const next = findNext(date)
    const prev = findPrev(date)

    const songkran = inMonthDayWindow(date, FESTIVAL_WINDOWS.songkran)
    const newyear = inMonthDayWindow(date, FESTIVAL_WINDOWS.newyear)

    out.set(date, {
      is_public_holiday: isPublicHoliday(date) ? 1 : 0,
      is_observance: info && !info.isPublic ? 1 : 0,
      holiday_name: info?.name ?? '',
      is_weekend: isWeekendDay(date) ? 1 : 0,
      is_holiday_eve: isPublicHoliday(addDays(date, 1)) ? 1 : 0,
      is_songkran: songkran ? 1 : 0,
      is_newyear: newyear ? 1 : 0,
      is_seven_dangerous_days: songkran || newyear ? 1 : 0,
      day_off_run_length: dayOffRunLength(date),
      is_long_weekend: dayOffRunLength(date) >= 3 ? 1 : 0,
      days_to_next_holiday: next ? daysBetween(date, next) : null,
      days_since_prev_holiday: prev ? daysBetween(prev, date) : null,
    })
  }
  return out
}
