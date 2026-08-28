import fs from 'node:fs'
import path from 'node:path'
import { DIR, START_DATE, RAIN_MM_THRESHOLD, HEAVY_RAIN_MM_THRESHOLD, REPORTING_LAG_DAYS } from '../config.js'
import { toCsv } from '../lib/csv.js'
import { dateRange, dayOfWeek, dayOfYear, daysBetween, monthOf, yearOf, addDays } from '../lib/dates.js'
import { makeProvinceResolver } from '../lib/provinceResolve.js'
import { fetchAllMot } from '../sources/motAccident.js'
import { fetchAllRtddi } from '../sources/rtddi.js'
import { fetchWeather } from '../sources/weather.js'
import { fetchHolidays, buildHolidayFeatures } from '../sources/holidays.js'
import { fetchHighwayTraffic, fetchOsmRoadProfile } from '../sources/roads.js'
import { buildProvinces } from './provinces.js'

const PANEL_FILE = path.join(DIR.processed, 'panel.csv')
const SPEC_FILE = path.join(DIR.processed, 'feature_spec.json')

const key = (geocode, date) => `${geocode}|${date}`

/**
 * โปรไฟล์ลักษณะทางรายจังหวัด คำนวณจาก "ปีก่อนหน้า" เท่านั้น
 *
 * ลักษณะทางในเรคคอร์ดอุบัติเหตุเป็นข้อมูลหลังเกิดเหตุ ใช้ตรง ๆ เป็น feature ไม่ได้
 * แต่สัดส่วนที่สรุปจากอดีตบอกได้ว่า "จังหวัดนี้อุบัติเหตุมักเกิดบนทางแบบไหน"
 * ซึ่งเป็นคุณสมบัติของพื้นที่ที่รู้ล่วงหน้าได้ จึงใช้เป็น feature ได้อย่างถูกต้อง
 */
function buildRoadProfileByYear(events) {
  const acc = new Map() // `${geocode}|${year}` -> {n, curve, slope, junction}
  for (const e of events) {
    if (e.roadCurve === null) continue
    const k = `${e.geocode}|${yearOf(e.date)}`
    if (!acc.has(k)) acc.set(k, { n: 0, curve: 0, slope: 0, junction: 0 })
    const a = acc.get(k)
    a.n++
    a.curve += e.roadCurve
    a.slope += e.roadSlope
    a.junction += e.roadJunction
  }

  const profile = new Map()
  for (const [k, a] of acc) {
    profile.set(k, {
      pct_curve: a.n > 0 ? a.curve / a.n : null,
      pct_slope: a.n > 0 ? a.slope / a.n : null,
      pct_junction: a.n > 0 ? a.junction / a.n : null,
      sample: a.n,
    })
  }
  return profile
}

function assert(condition, message) {
  if (!condition) throw new Error(`ตรวจข้อมูลไม่ผ่าน: ${message}`)
}

export async function buildPanel({ skipOsm = false, write = true } = {}) {
  fs.mkdirSync(DIR.processed, { recursive: true })

  console.log('1/6 จังหวัด ...')
  const provinces = await buildProvinces()
  const resolveProvince = makeProvinceResolver(provinces.map((p) => ({ geocode: p.geocode, name_th: p.name_th })))

  console.log('2/6 อุบัติเหตุ (MOT) ...')
  const { events: motEvents } = await fetchAllMot(resolveProvince)

  console.log('3/6 ผู้เสียชีวิตทุกถนน (RTDDI) ...')
  const { events: rtddiEvents } = await fetchAllRtddi(resolveProvince)

  // ขอบเขตเวลาของ panel กำหนดจากวันสุดท้ายที่ MOT มีข้อมูลจริง ไม่ hard-code
  const motDates = motEvents.map((e) => e.date).sort()
  const endDate = motDates[motDates.length - 1]
  const dates = dateRange(START_DATE, endDate)
  console.log(`   ช่วงข้อมูล ${START_DATE} → ${endDate} (${dates.length} วัน)`)

  console.log('4/6 สภาพอากาศ ...')
  const weather = await fetchWeather(provinces, START_DATE, endDate)

  console.log('5/6 วันหยุด/เทศกาล ...')
  const holidayFeatures = buildHolidayFeatures(dates, await fetchHolidays())

  console.log('6/6 ลักษณะเส้นทาง ...')
  const traffic = await fetchHighwayTraffic(resolveProvince)
  const osm = skipOsm ? new Map() : await fetchOsmRoadProfile(provinces)

  // ---- รวมยอดอุบัติเหตุรายจังหวัด-วัน ----
  const motByCell = new Map()
  for (const e of motEvents) {
    const k = key(e.geocode, e.date)
    if (!motByCell.has(k)) motByCell.set(k, { count: 0, dead: 0, injured: 0, rainReported: 0 })
    const c = motByCell.get(k)
    c.count++
    c.dead += e.dead
    c.injured += e.injuredTotal
    if (e.weatherReported === 'rain') c.rainReported++
  }

  const rtddiByCell = new Map()
  for (const e of rtddiEvents) {
    const k = key(e.geocode, e.date)
    rtddiByCell.set(k, (rtddiByCell.get(k) ?? 0) + 1)
  }
  const rtddiDates = rtddiEvents.map((e) => e.date).sort()
  const rtddiEnd = rtddiDates[rtddiDates.length - 1]

  const roadProfile = buildRoadProfileByYear(motEvents)

  // ---- สร้าง panel ----
  const rows = []
  const lagCutoff = addDays(endDate, -REPORTING_LAG_DAYS)

  for (const province of provinces) {
    const provinceWeather = weather.get(province.geocode)
    const provinceTraffic = traffic.get(province.geocode) ?? {}
    const provinceOsm = osm.get(province.geocode) ?? null

    // ประวัติย้อนหลังของจังหวัดนี้ เรียงตามวัน เพื่อคำนวณ rolling แบบไม่แอบดูอนาคต
    const counts = dates.map((d) => motByCell.get(key(province.geocode, d))?.count ?? 0)

    for (const [i, date] of dates.entries()) {
      const cell = motByCell.get(key(province.geocode, date))
      const w = provinceWeather?.get(date) ?? {}
      const h = holidayFeatures.get(date)
      const year = yearOf(date)

      // โปรไฟล์ลักษณะทางของ "ปีก่อนหน้า" — ปีแรกสุดจะไม่มี จึงเป็น null
      const prof = roadProfile.get(`${province.geocode}|${year - 1}`) ?? {}

      // rolling ทั้งหมดตัดถึงเมื่อวาน (i-1) ห้ามรวมวันปัจจุบัน
      const window = (n) => {
        const from = Math.max(0, i - n)
        const slice = counts.slice(from, i)
        return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : null
      }
      const sameDowMean = () => {
        const values = []
        for (let k = i - 7; k >= 0; k -= 7) values.push(counts[k])
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
      }

      const precip = w.precip_mm ?? null
      const prevDay = i > 0 ? provinceWeather?.get(dates[i - 1]) : null
      const prev2Day = i > 1 ? provinceWeather?.get(dates[i - 2]) : null

      rows.push({
        // ---- คีย์ ----
        geocode: province.geocode,
        province: province.name_th,
        date,
        year,

        // ---- target ----
        y_accident: cell ? 1 : 0,
        y_accident_count: cell?.count ?? 0,
        y_dead: cell?.dead ?? 0,
        y_injured: cell?.injured ?? 0,
        y_dead_all_roads: date <= rtddiEnd ? (rtddiByCell.get(key(province.geocode, date)) ?? 0) : '',

        // ---- เวลา ----
        dow: dayOfWeek(date),
        month: monthOf(date),
        doy_sin: Math.sin((2 * Math.PI * dayOfYear(date)) / 365.25).toFixed(6),
        doy_cos: Math.cos((2 * Math.PI * dayOfYear(date)) / 365.25).toFixed(6),
        days_since_start: daysBetween(START_DATE, date),

        // ---- สภาพอากาศ (พยากรณ์ล่วงหน้าได้) ----
        precip_mm: precip,
        rain_mm: w.rain_mm ?? null,
        precip_hours: w.precip_hours ?? null,
        temp_max: w.temp_max ?? null,
        temp_min: w.temp_min ?? null,
        wind_max: w.wind_max ?? null,
        is_rainy: precip !== null && precip > RAIN_MM_THRESHOLD ? 1 : 0,
        is_heavy_rain: precip !== null && precip > HEAVY_RAIN_MM_THRESHOLD ? 1 : 0,
        rain_lag1: prevDay?.precip_mm ?? null,
        rain_3d_sum:
          precip !== null
            ? Number((precip + (prevDay?.precip_mm ?? 0) + (prev2Day?.precip_mm ?? 0)).toFixed(2))
            : null,

        // ---- เทศกาล ----
        ...h,

        // ---- ลักษณะเส้นทาง (คงที่รายจังหวัด) ----
        highway_km: provinceTraffic.highway_km ?? null,
        vehicle_km: provinceTraffic.vehicle_km ?? null,
        avg_lanes: provinceTraffic.avg_lanes ?? null,
        osm_motorway_ways: provinceOsm?.osm_motorway_ways ?? null,
        osm_trunk_ways: provinceOsm?.osm_trunk_ways ?? null,
        osm_primary_ways: provinceOsm?.osm_primary_ways ?? null,
        osm_secondary_ways: provinceOsm?.osm_secondary_ways ?? null,
        osm_traffic_signals: provinceOsm?.osm_traffic_signals ?? null,

        // ---- โปรไฟล์ลักษณะทางจากปีก่อนหน้า ----
        pct_curve_prev: prof.pct_curve ?? null,
        pct_slope_prev: prof.pct_slope ?? null,
        pct_junction_prev: prof.pct_junction ?? null,

        // ---- การเปิดรับความเสี่ยง ----
        population: province.population,
        area_km2: province.area_km2,
        log_population: province.population ? Math.log(province.population).toFixed(4) : null,
        motorcycle_per_capita:
          province.population && province.motorcycles
            ? (province.motorcycles / province.population).toFixed(4)
            : null,
        vehicle_density:
          province.area_km2 && province.cars && province.motorcycles
            ? ((province.cars + province.motorcycles) / province.area_km2).toFixed(2)
            : null,
        road_km_per_area:
          province.area_km2 && provinceTraffic.highway_km
            ? (provinceTraffic.highway_km / province.area_km2).toFixed(4)
            : null,

        // ---- ประวัติ (ตัดถึงเมื่อวาน) ----
        acc_roll7_prev: window(7)?.toFixed(4) ?? null,
        acc_roll28_prev: window(28)?.toFixed(4) ?? null,
        acc_same_dow_mean_prev: sameDowMean()?.toFixed(4) ?? null,

        // ---- ธง ----
        is_recent_90d: date > lagCutoff ? 1 : 0,

        // ---- ตรวจสอบเท่านั้น ห้ามใช้เป็น feature ----
        check_rain_reported: cell?.rainReported ?? 0,
      })
    }
  }

  // ---- Assertions ----
  console.log('ตรวจสอบข้อมูล ...')
  assert(rows.length === provinces.length * dates.length, `จำนวนแถวควรเป็น ${provinces.length * dates.length} แต่ได้ ${rows.length}`)

  const seen = new Set()
  for (const r of rows) {
    const k = key(r.geocode, r.date)
    assert(!seen.has(k), `พบ (จังหวัด, วันที่) ซ้ำ: ${k}`)
    seen.add(k)
  }

  const panelTotal = rows.reduce((a, r) => a + r.y_accident_count, 0)
  assert(
    panelTotal === motEvents.length,
    `ยอดอุบัติเหตุใน panel (${panelTotal}) ไม่ตรงกับจำนวนเหตุการณ์ที่โหลดมา (${motEvents.length})`,
  )

  const weatherNulls = rows.filter((r) => r.precip_mm === null).length
  assert(
    weatherNulls / rows.length < 0.01,
    `ข้อมูลอากาศหาย ${((100 * weatherNulls) / rows.length).toFixed(2)}% (เกิน 1%)`,
  )

  const leaky = ['สภาพอากาศ', 'ลักษณะทาง', 'weatherReported', 'roadGeometryLabel']
  for (const col of Object.keys(rows[0])) {
    assert(!leaky.includes(col), `คอลัมน์ที่ทำให้ leak หลุดเข้ามา: ${col}`)
  }

  // ---- สรุปยอดรายปี ----
  const byYear = {}
  for (const r of rows) byYear[r.year] = (byYear[r.year] ?? 0) + r.y_accident_count
  console.log('   ยอดอุบัติเหตุรายปี:', byYear)

  // ---- เขียนไฟล์ ----
  const headers = Object.keys(rows[0])
  const osmUsable = [...osm.values()].filter(Boolean).length
  const spec = {
    generated_at: new Date().toISOString(),
    rows: rows.length,
    provinces: provinces.length,
    date_start: START_DATE,
    date_end: endDate,
    accidents_total: panelTotal,
    accidents_by_year: byYear,
    osm_coverage: skipOsm ? 'ข้าม' : `${osmUsable}/${provinces.length}`,
    targets: ['y_accident', 'y_accident_count', 'y_dead', 'y_injured', 'y_dead_all_roads'],
    exclude_from_features: [
      'geocode', 'province', 'date', 'year', 'holiday_name',
      'y_accident', 'y_accident_count', 'y_dead', 'y_injured', 'y_dead_all_roads',
      'check_rain_reported', 'is_recent_90d',
    ],
    columns: headers,
  }
  if (write) {
    fs.writeFileSync(PANEL_FILE, toCsv(rows, headers), 'utf8')
    fs.writeFileSync(SPEC_FILE, JSON.stringify(spec, null, 2), 'utf8')
    console.log(`\nเขียน ${PANEL_FILE} (${rows.length} แถว, ${headers.length} คอลัมน์)`)
    console.log(`เขียน ${SPEC_FILE}`)
  } else {
    console.log(`\nเตรียมข้อมูลครบแล้ว (${rows.length} แถว) — ข้ามการเขียนไฟล์ตามที่สั่ง`)
  }
  return { rows, spec, motEvents }
}

export { PANEL_FILE, SPEC_FILE }
