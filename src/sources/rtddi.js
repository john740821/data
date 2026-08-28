import { RTDDI_DATASET_UUID, RTDDI_RESOURCES } from '../config.js'
import { fetchCached } from '../lib/http.js'
import { parseCsv, parseNumber } from '../lib/csv.js'
import { normalizeDate } from '../lib/dates.js'
import { makeProvinceResolver, provinceKey } from '../lib/provinceResolve.js'

// re-export เพื่อความเข้ากันได้กับโค้ดที่ import จากไฟล์นี้อยู่แล้ว
export { makeProvinceResolver, provinceKey }

const resourceUrl = (r) =>
  `https://data.go.th/dataset/${RTDDI_DATASET_UUID}/resource/${r.resourceId}/download/${r.file}`

/**
 * แยกว่าค่าไหนเป็น lat ค่าไหนเป็น lon โดยดูจากช่วงค่า ไม่ดูชื่อคอลัมน์
 * เพราะต้นทางสลับไม่เหมือนกันในแต่ละปี (2565 ไม่สลับ / 2567, 2569 สลับ)
 * ละติจูดไทยอยู่ 5-21 ลองจิจูด 96-106 — สองช่วงนี้ไม่ทับกัน จึงแยกได้แน่นอน
 */
export function orientCoords(a, b) {
  const isLat = (v) => v !== null && v > 5 && v < 21
  const isLon = (v) => v !== null && v > 96 && v < 106
  if (isLat(a) && isLon(b)) return { lat: a, lon: b }
  if (isLat(b) && isLon(a)) return { lat: b, lon: a }
  return { lat: null, lon: null }
}

/**
 * โหลดเหตุการณ์เสียชีวิตรายเคสของหนึ่งปี แล้ว normalize schema ที่ต่างกันทุกปี
 * @returns {{events: object[], stats: object}}
 */
export async function fetchRtddiYear(resource, resolveProvince) {
  const buf = await fetchCached(resourceUrl(resource), { label: `rtddi:${resource.yearBE}` })
  const { headers, rows } = parseCsv(buf)
  const c = resource.columns

  for (const required of [c.date, c.province]) {
    if (!headers.includes(required)) {
      throw new Error(
        `RTDDI ${resource.yearBE}: ไม่พบคอลัมน์ "${required}" — schema เปลี่ยนอีกแล้ว\nheaders: ${headers.join(' | ')}`,
      )
    }
  }

  const events = []
  const unmapped = new Map()
  let noDate = 0
  let withCoord = 0

  for (const row of rows) {
    const date = normalizeDate(row[c.date], c.dateFormat)
    if (!date) {
      noDate++
      continue
    }
    const rawProvince = row[c.province]
    const geocode = resolveProvince(rawProvince)
    if (!geocode) {
      unmapped.set(rawProvince, (unmapped.get(rawProvince) || 0) + 1)
      continue
    }

    // ต้นทางสลับคอลัมน์ lat/long ไม่เหมือนกันในแต่ละปี (2565 ถูก, 2567/2569 สลับ)
    // จึงแยกด้วยช่วงค่าแทนชื่อคอลัมน์ — ละติจูดไทยอยู่ 5-21 ลองจิจูด 96-106 ไม่ทับกัน
    const { lat, lon } = orientCoords(parseNumber(row[c.lonCol]), parseNumber(row[c.latCol]))
    const hasCoord = lat !== null
    if (hasCoord) withCoord++

    events.push({
      date,
      geocode,
      lat: hasCoord ? lat : null,
      lon: hasCoord ? lon : null,
      vehicle: (row[c.vehicle] || '').trim() || null,
      icd10: (row[c.icd] || '').trim() || null,
      age: parseNumber(row[c.age]),
      sex: (row[c.sex] || '').trim() || null,
    })
  }

  return {
    events,
    stats: {
      yearBE: resource.yearBE,
      rawRows: rows.length,
      kept: events.length,
      noDate,
      withCoord,
      unmapped: [...unmapped.entries()].sort((a, b) => b[1] - a[1]),
    },
  }
}

/** โหลดทุกปีตาม config */
export async function fetchAllRtddi(resolveProvince) {
  const all = []
  const stats = []
  for (const resource of RTDDI_RESOURCES) {
    console.log(`  RTDDI ${resource.yearBE} ...`)
    const { events, stats: s } = await fetchRtddiYear(resource, resolveProvince)
    all.push(...events)
    stats.push(s)
    console.log(
      `    แถวดิบ ${s.rawRows} | ใช้ได้ ${s.kept} | ไม่มีวันที่ ${s.noDate} | จังหวัด map ไม่ได้ ${s.rawRows - s.kept - s.noDate} | มีพิกัด ${s.withCoord}`,
    )
  }
  return { events: all, stats }
}

export { resourceUrl }
