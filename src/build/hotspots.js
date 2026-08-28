import fs from 'node:fs'
import path from 'node:path'
import { DIR } from '../config.js'
import { toCsv } from '../lib/csv.js'

const HOTSPOTS_FILE = path.join(DIR.processed, 'hotspots.csv')

/** ค่าที่พบบ่อยที่สุดใน array (ข้ามค่าว่าง) */
function mode(values) {
  const counts = new Map()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best = null
  let bestCount = 0
  for (const [v, n] of counts) {
    if (n > bestCount) {
      bestCount = n
      best = v
    }
  }
  return best
}

/**
 * จัดอันดับจุดเสี่ยงระดับ "สายทาง + ช่วงกิโลเมตร"
 *
 * นี่คือผลลัพธ์ที่เอาไปลงมือแก้ได้จริง — โมเดลระดับจังหวัดบอกได้แค่ว่าวันไหนเสี่ยง
 * แต่ตารางนี้บอกว่า "ต้องไปแก้ตรงไหน" ซึ่งตรงกับเป้าหมายลดอุบัติเหตุมากกว่า
 *
 * ให้คะแนนความรุนแรงแบบถ่วงน้ำหนัก: เสียชีวิต 10 / บาดเจ็บ 1
 * เพื่อไม่ให้จุดที่เกิดบ่อยแต่เบา บดบังจุดที่เกิดน้อยแต่ถึงตาย
 *
 * @param {object[]} events ผลจาก fetchAllMot()
 * @param {{geocode:string,name_th:string}[]} provinces
 */
export function buildHotspots(events, provinces, { minAccidents = 3, topN = 2000 } = {}) {
  const nameByGeocode = new Map(provinces.map((p) => [p.geocode, p.name_th]))
  const groups = new Map()

  for (const e of events) {
    if (!e.routeId || e.km === null) continue
    const kmBucket = Math.floor(e.km) // รวมเป็นช่วงละ 1 กม.
    const k = `${e.routeId}|${kmBucket}`

    if (!groups.has(k)) {
      groups.set(k, {
        routeId: e.routeId,
        routeName: e.routeName,
        kmFrom: kmBucket,
        geocodes: [],
        agencies: [],
        geometries: [],
        causes: [],
        accidents: 0,
        dead: 0,
        injured: 0,
        rainAccidents: 0,
        years: new Set(),
      })
    }
    const g = groups.get(k)
    g.accidents++
    g.dead += e.dead
    g.injured += e.injuredTotal
    if (e.weatherReported === 'rain') g.rainAccidents++
    g.geocodes.push(e.geocode)
    g.agencies.push(e.agency)
    g.geometries.push(e.roadGeometryLabel)
    g.causes.push(e.cause)
    g.years.add(e.date.slice(0, 4))
    if (!g.routeName && e.routeName) g.routeName = e.routeName
  }

  const rows = []
  for (const g of groups.values()) {
    if (g.accidents < minAccidents) continue
    const geocode = mode(g.geocodes)
    rows.push({
      route_id: g.routeId,
      route_name: g.routeName ?? '',
      km_from: g.kmFrom,
      km_to: g.kmFrom + 1,
      province: nameByGeocode.get(geocode) ?? '',
      geocode,
      agency: mode(g.agencies) ?? '',
      accidents: g.accidents,
      dead: g.dead,
      injured: g.injured,
      severity_score: g.dead * 10 + g.injured,
      accidents_per_year: Number((g.accidents / g.years.size).toFixed(2)),
      years_observed: g.years.size,
      rain_share: Number((g.rainAccidents / g.accidents).toFixed(3)),
      common_geometry: mode(g.geometries) ?? '',
      common_cause: mode(g.causes) ?? '',
    })
  }

  rows.sort((a, b) => b.severity_score - a.severity_score || b.accidents - a.accidents)
  return rows.slice(0, topN)
}

export function writeHotspots(events, provinces, options) {
  fs.mkdirSync(DIR.processed, { recursive: true })
  const rows = buildHotspots(events, provinces, options)
  if (rows.length === 0) {
    console.warn('  ⚠️ ไม่พบจุดเสี่ยงที่เข้าเกณฑ์ — ตรวจว่า routeId/km ถูก parse มาหรือไม่')
    return rows
  }
  fs.writeFileSync(HOTSPOTS_FILE, toCsv(rows), 'utf8')
  console.log(`เขียน ${HOTSPOTS_FILE} (${rows.length} จุด)`)
  console.log('  10 อันดับแรก:')
  for (const r of rows.slice(0, 10)) {
    console.log(
      `    ${r.route_id} กม.${r.km_from}-${r.km_to} (${r.province}) — ` +
        `${r.accidents} ครั้ง ตาย ${r.dead} เจ็บ ${r.injured} | ${r.common_geometry}`,
    )
  }
  return rows
}

export { HOTSPOTS_FILE }
