import { THAIRSC } from '../config.js'
import { postFormJson } from '../lib/http.js'
import { parseNumber } from '../lib/csv.js'

const url = (p) => THAIRSC.base + p

function unwrap(payload, label) {
  if (!payload || payload.Status !== 1) {
    throw new Error(`ThaiRSC ${label} ตอบผิดปกติ: ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return payload.Data
}

/**
 * รายชื่อจังหวัดหลัก (geocode + ชื่อไทย) จาก ThaiRSC
 * ใช้เป็น master list เพราะเป็นชุดเดียวที่มี geocode มาตรฐานให้ครบ
 */
export async function fetchProvinceMaster() {
  const payload = await postFormJson(url(THAIRSC.provinceList), {}, { label: 'thairsc:provinceList' })
  const data = unwrap(payload, 'get_thailand_stats')
  const seen = new Map()
  for (const row of data) {
    const geocode = String(row.geocode || '').trim()
    const name = String(row.province_name || '').trim()
    if (!geocode || !name) continue
    if (!seen.has(geocode)) {
      seen.set(geocode, { geocode, name_th: name, deaths_ytd: parseNumber(row.death) })
    }
  }
  return [...seen.values()].sort((a, b) => Number(a.geocode) - Number(b.geocode))
}

/**
 * ตัวชี้วัดการเปิดรับความเสี่ยงรายจังหวัด: ประชากร, จำนวนรถจักรยานยนต์, รถยนต์, พื้นที่
 * (ThaiRSC สะกดคีย์ว่า "Mortorcycle" — คงไว้ตามต้นทาง)
 */
export async function fetchProvinceStat(geocode) {
  const payload = await postFormJson(
    url(THAIRSC.statProvince),
    { geocode },
    { label: `thairsc:stat:${geocode}` },
  )
  const d = unwrap(payload, `GetStatProvince(${geocode})`)
  return {
    geocode,
    population: parseNumber(d.Population),
    motorcycles: parseNumber(d.Mortorcycle),
    cars: parseNumber(d.Car),
    area_km2: parseNumber(d.Area),
  }
}

/**
 * จำนวนอุบัติเหตุ/บาดเจ็บ/เสียชีวิตรายอำเภอ (ยอดสะสมปีปัจจุบันเท่านั้น)
 * ใช้ทำ feature "สัดส่วนอุบัติเหตุที่กระจุกในอำเภอเดียว" ระดับจังหวัด
 */
export async function fetchDistrictAccidents(geocode) {
  const payload = await postFormJson(
    url(THAIRSC.accidentPerDistrict),
    { geocode },
    { label: `thairsc:district:${geocode}` },
  )
  const d = unwrap(payload, `GetAccidentperDistrict(${geocode})`)
  return (d.Accident || []).map((r) => ({
    district: String(r.Name || '').trim(),
    accidents: parseNumber(r.Accident),
    dead: parseNumber(r.Dead),
    injured: parseNumber(r.Injured),
  }))
}

/**
 * ยอดรวมประเทศ ณ ปัจจุบัน — ไม่ใช้เป็น feature (ไม่มีมิติเวลาย้อนหลัง)
 * แต่ใช้ยืนยันว่า API ยังใช้งานได้ และเก็บไว้อ้างอิงว่าข้อมูลอัปเดตถึงเมื่อไหร่
 */
export async function fetchNationalSummary() {
  const payload = await postFormJson(url(THAIRSC.nationalSummary), {}, { label: 'thairsc:section1_1' })
  const d = unwrap(payload, 'section1_1')
  return {
    today_death: parseNumber(d.Today_Death),
    yesterday_death: parseNumber(d.Yesterday_Death),
    year_death: parseNumber(d.Year_Death),
    year_injuries: parseNumber(d.Year_Injuries),
    current_year_be: d.CurrentYear,
    data_update: d.DataUpdate,
  }
}
