import { OPEN_METEO, OPEN_METEO_DAILY } from '../config.js'
import { fetchJson, sleep } from '../lib/http.js'

// Open-Meteo จำกัด burst ค่อนข้างเข้ม — 10 จังหวัด/request ยิงติด ๆ กันโดน 429 ตั้งแต่ชุดที่ 3
// ลดขนาด batch แล้วหน่วงระหว่างชุด ยอมช้ารอบแรก ~1.5 นาที แลกกับไม่ต้องมานั่ง retry
const BATCH_SIZE = 5
// 5 วิยังโดน 429 อยู่เรื่อย ๆ (ผ่านไป 55/77 จังหวัดแล้วหมด retry)
// Open-Meteo คิดโควตาตามปริมาณข้อมูล ไม่ใช่จำนวน request — batch นี้ขอ 5 จังหวัด x 1,581 วัน x 6 ตัวแปร
// ยอมช้าเป็น ~4 นาทีรอบแรก ดีกว่าต้องรันซ้ำหลายรอบ (batch ที่สำเร็จถูก cache ไว้อยู่แล้ว)
const DELAY_BETWEEN_BATCHES_MS = 15_000

/**
 * ดึงสภาพอากาศรายวันย้อนหลังจาก Open-Meteo (ฟรี ไม่ต้องใช้ API key)
 *
 * Open-Meteo รับหลายพิกัดต่อหนึ่ง request โดยคั่นด้วยคอมมา แล้วคืน array กลับมา
 * แต่ถ้าส่งพิกัดเดียวจะคืน object เดี่ยว ไม่ใช่ array — ต้องรองรับทั้งสองแบบ
 *
 * @param {{geocode:string, lat:number, lon:number}[]} provinces
 * @param {string} startDate 'YYYY-MM-DD'
 * @param {string} endDate 'YYYY-MM-DD'
 * @returns {Promise<Map<string, Map<string, object>>>} geocode -> (date -> ค่าอากาศ)
 */
export async function fetchWeather(provinces, startDate, endDate) {
  const byProvince = new Map()

  for (let i = 0; i < provinces.length; i += BATCH_SIZE) {
    const batch = provinces.slice(i, i + BATCH_SIZE)
    const params = new URLSearchParams({
      latitude: batch.map((p) => p.lat.toFixed(4)).join(','),
      longitude: batch.map((p) => p.lon.toFixed(4)).join(','),
      start_date: startDate,
      end_date: endDate,
      daily: OPEN_METEO_DAILY.join(','),
      timezone: 'Asia/Bangkok',
    })

    const url = `${OPEN_METEO}?${params}`
    console.log(`  อากาศ ${i + 1}-${i + batch.length} / ${provinces.length} ...`)
    const payload = await fetchJson(url, { label: `weather:${i}`, timeoutMs: 240_000 })
    const results = Array.isArray(payload) ? payload : [payload]

    if (results.length !== batch.length) {
      throw new Error(
        `Open-Meteo คืนผลมา ${results.length} จุด แต่ขอไป ${batch.length} จุด — batch ที่ ${i}`,
      )
    }

    results.forEach((result, idx) => {
      const province = batch[idx]
      const daily = result.daily
      if (!daily || !Array.isArray(daily.time)) {
        throw new Error(`Open-Meteo ไม่คืนข้อมูลรายวันของ ${province.geocode}`)
      }
      const byDate = new Map()
      daily.time.forEach((date, k) => {
        byDate.set(date, {
          precip_mm: daily.precipitation_sum?.[k] ?? null,
          rain_mm: daily.rain_sum?.[k] ?? null,
          precip_hours: daily.precipitation_hours?.[k] ?? null,
          temp_max: daily.temperature_2m_max?.[k] ?? null,
          temp_min: daily.temperature_2m_min?.[k] ?? null,
          wind_max: daily.windspeed_10m_max?.[k] ?? null,
        })
      })
      byProvince.set(province.geocode, byDate)
    })

    if (i + BATCH_SIZE < provinces.length) await sleep(DELAY_BETWEEN_BATCHES_MS)
  }

  return byProvince
}
