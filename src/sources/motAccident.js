import { MOT_DATASET_UUID, MOT_RESOURCES, MOT_COLUMNS } from '../config.js'
import { fetchCached } from '../lib/http.js'
import { parseCsv, parseNumber } from '../lib/csv.js'
import { detectDateFormat, parseDateByFormat, yearOf } from '../lib/dates.js'
import {
  buildRoutePrefixIndex,
  resolveByRoutePrefix,
  makeCoordResolver,
} from '../lib/provinceResolve.js'

const resourceUrl = (r) =>
  `https://datagov.mot.go.th/dataset/${MOT_DATASET_UUID}/resource/${r.resourceId}/download/${r.file}`

/** เลือกชื่อคอลัมน์ตัวแรกที่มีอยู่จริงใน header */
function pickColumn(headers, candidates, { required = true, yearBE } = {}) {
  for (const name of candidates) {
    if (headers.includes(name)) return name
  }
  if (required) {
    throw new Error(
      `MOT ${yearBE}: ไม่พบคอลัมน์ใดเลยจาก [${candidates.join(', ')}] — schema เปลี่ยนอีกแล้ว\n` +
        `headers ที่มีจริง: ${headers.join(' | ')}`,
    )
  }
  return null
}

/**
 * จัดกลุ่มลักษณะทางจากข้อความดิบ ให้เหลือหมวดที่ใช้ทำ feature ได้
 * ต้นทางเขียนรวมกันมา เช่น "ทางโค้งกว้าง+ที่ลาดชัน" ซึ่งเป็นทั้งโค้งและลาดชัน
 */
export function classifyRoadGeometry(raw) {
  const s = (raw || '').trim()
  if (s === '') return { curve: null, slope: null, junction: null, label: null }
  return {
    curve: /โค้ง/.test(s) ? 1 : 0,
    slope: /ลาดชัน/.test(s) && !/ไม่มีความลาดชัน/.test(s) ? 1 : 0,
    junction: /แยก|ทางเชื่อม|วงเวียน|ทางร่วม/.test(s) ? 1 : 0,
    label: s,
  }
}

/** สภาพอากาศที่รายงาน ณ จุดเกิดเหตุ — ใช้ตรวจสอบข้อมูล Open-Meteo เท่านั้น ห้ามใช้เป็น feature */
export function classifyReportedWeather(raw) {
  const s = (raw || '').trim()
  if (s === '') return null
  if (/ฝนตก/.test(s)) return 'rain'
  if (/แจ่มใส/.test(s)) return 'clear'
  if (/หมอก|ควัน|ฝุ่น/.test(s)) return 'fog'
  if (/มืดครึ้ม/.test(s)) return 'overcast'
  if (/พายุ|น้ำท่วม|ภัยธรรมชาติ/.test(s)) return 'storm'
  return 'other'
}

/**
 * โหลดอุบัติเหตุรายเหตุการณ์ของหนึ่งปี
 * @returns {{events: object[], stats: object}}
 */
export async function fetchMotYear(resource, resolveProvince) {
  const buf = await fetchCached(resourceUrl(resource), { label: `mot:${resource.yearBE}` })
  const { headers, rows } = parseCsv(buf)
  const yearBE = resource.yearBE

  const col = {}
  for (const [key, candidates] of Object.entries(MOT_COLUMNS)) {
    const optional = ['crashType', 'injuredTotal', 'vehicleFirst', 'routeName']
    col[key] = pickColumn(headers, candidates, { required: !optional.includes(key), yearBE })
  }

  // เดารูปแบบวันที่จากข้อมูลจริงของไฟล์นี้ ไม่ใช่จากปี
  const sample = rows.slice(0, 5000).map((r) => r[col.date])
  const dateFormat = detectDateFormat(sample)
  if (!dateFormat) {
    throw new Error(
      `MOT ${yearBE}: แยกรูปแบบวันที่ไม่ออก (อาจเป็น D/M หรือ M/D ก็ได้ทั้งคู่) — ` +
        `ตัวอย่าง: ${sample.filter(Boolean).slice(0, 5).join(', ')}\n` +
        `ต้องตรวจไฟล์ด้วยมือแล้วระบุรูปแบบเอง อย่าปล่อยให้เดา`,
    )
  }

  const events = []
  const unmapped = new Map()
  let noDate = 0
  let yearMismatch = 0
  let withCoord = 0

  for (const row of rows) {
    const date = parseDateByFormat(row[col.date], dateFormat)
    if (!date) {
      noDate++
      continue
    }

    // ยามกันพลาดที่สำคัญที่สุดของไฟล์ชุดนี้: ถ้าสลับ วัน/เดือน ปีจะยังถูกอยู่แต่ข้อมูลพังเงียบ ๆ
    // จึงเทียบกับคอลัมน์ปีที่ต้นทางระบุมาเอง
    const statedYear = parseNumber(row[col.year])
    if (statedYear !== null && yearOf(date) !== statedYear) {
      yearMismatch++
      continue
    }

    const geocode = resolveProvince(row[col.province])
    if (!geocode) {
      const key = (row[col.province] || '(ว่าง)').trim()
      unmapped.set(key, (unmapped.get(key) || 0) + 1)
    }

    const lat = parseNumber(row[col.lat])
    const lon = parseNumber(row[col.lon])
    const hasCoord = lat !== null && lon !== null && lat > 5 && lat < 21 && lon > 96 && lon < 106
    if (hasCoord) withCoord++

    const geometry = classifyRoadGeometry(row[col.roadGeometry])
    const dead = parseNumber(row[col.dead]) ?? 0
    const severe = parseNumber(row[col.injuredSevere]) ?? 0
    const minor = parseNumber(row[col.injuredMinor]) ?? 0

    events.push({
      date,
      time: (row[col.time] || '').trim() || null,
      geocode, // อาจเป็น null ตรงนี้ แล้วค่อยกู้คืนใน recoverMissingProvinces()
      lat: hasCoord ? lat : null,
      lon: hasCoord ? lon : null,
      agency: (row[col.agency] || '').trim() || null,
      routeId: (row[col.routeId] || '').trim() || null,
      routeName: col.routeName ? (row[col.routeName] || '').trim() || null : null,
      km: parseNumber(row[col.km]),
      roadCurve: geometry.curve,
      roadSlope: geometry.slope,
      roadJunction: geometry.junction,
      roadGeometryLabel: geometry.label,
      cause: (row[col.cause] || '').trim() || null,
      weatherReported: classifyReportedWeather(row[col.weather]),
      dead,
      injuredSevere: severe,
      injuredMinor: minor,
      injuredTotal: parseNumber(col.injuredTotal ? row[col.injuredTotal] : null) ?? severe + minor,
    })
  }

  return {
    events,
    stats: {
      yearBE,
      dateFormat,
      rawRows: rows.length,
      kept: events.length,
      noDate,
      yearMismatch,
      withCoord,
      missingProvince: events.filter((e) => e.geocode === null).length,
      unmapped: [...unmapped.entries()].sort((a, b) => b[1] - a[1]),
    },
  }
}

/**
 * กู้จังหวัดของแถวที่ชื่อจังหวัดว่างหรือสะกดจนหาไม่เจอ
 * ปี 2567 มีแถวแบบนี้เกือบ 2,000 แถว (8% ของทั้งปี) — ทิ้งไปเฉย ๆ จะทำให้ปีนั้นต่ำผิดปกติ
 *
 * ลำดับการกู้: รหัสสายทาง (แม่นสุด) -> พิกัดแบบ kNN -> ยอมแพ้
 */
export function recoverMissingProvinces(events) {
  const mapped = events.filter((e) => e.geocode !== null)
  const missing = events.filter((e) => e.geocode === null)
  if (missing.length === 0) return { byRoute: 0, byCoord: 0, stillMissing: 0 }

  const routeIndex = buildRoutePrefixIndex(mapped)
  const resolveCoord = makeCoordResolver(mapped.filter((e) => e.lat !== null))

  let byRoute = 0
  let byCoord = 0
  for (const e of missing) {
    const fromRoute = resolveByRoutePrefix(e.routeId, routeIndex)
    if (fromRoute) {
      e.geocode = fromRoute
      e.geocodeSource = 'route'
      byRoute++
      continue
    }
    const fromCoord = resolveCoord(e.lat, e.lon)
    if (fromCoord) {
      e.geocode = fromCoord
      e.geocodeSource = 'coord'
      byCoord++
    }
  }

  return { byRoute, byCoord, stillMissing: events.filter((e) => e.geocode === null).length }
}

/** โหลดทุกปีตาม config */
export async function fetchAllMot(resolveProvince) {
  const all = []
  const stats = []
  for (const resource of MOT_RESOURCES) {
    console.log(`  MOT ${resource.yearBE} ...`)
    const { events, stats: s } = await fetchMotYear(resource, resolveProvince)
    all.push(...events)
    stats.push(s)
    console.log(
      `    แถวดิบ ${s.rawRows} | อ่านได้ ${s.kept} | รูปแบบวันที่ ${s.dateFormat} | ` +
        `ไม่มีวันที่ ${s.noDate} | ปีไม่ตรง ${s.yearMismatch} | จังหวัดหาย ${s.missingProvince} | มีพิกัด ${s.withCoord}`,
    )
    if (s.yearMismatch > 0) {
      console.warn(`    ⚠️ ปี ${s.yearBE} มี ${s.yearMismatch} แถวที่ปีจากวันที่ไม่ตรงกับคอลัมน์ "ปีที่เกิดเหตุ"`)
    }
  }

  const recovery = recoverMissingProvinces(all)
  console.log(
    `  กู้จังหวัดที่หายไป: จากรหัสสายทาง ${recovery.byRoute} | จากพิกัด ${recovery.byCoord} | กู้ไม่ได้ ${recovery.stillMissing}`,
  )

  const usable = all.filter((e) => e.geocode !== null)
  console.log(`  รวมใช้ได้ ${usable.length} เหตุการณ์`)
  return { events: usable, stats, recovery }
}

export { resourceUrl }
