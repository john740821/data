import { CKAN, DOH_VK_PROVINCE_RESOURCE, OVERPASS, OSM_ROAD_CLASSES } from '../config.js'
import { fetchJson, fetchCached, sleep } from '../lib/http.js'
import { parseNumber } from '../lib/csv.js'

/**
 * ปริมาณการเดินทางบนทางหลวงรายจังหวัด จากกรมทางหลวง
 *
 * ต้องอ่านผ่าน CKAN datastore เท่านั้น — URL ดาวน์โหลด CSV ตรงของ data.doh.go.th ตาย 404 หมดแล้ว
 * ข้อมูลมีหลายแถวต่อจังหวัด (แยกตามจำนวนช่องจราจร) จึงต้องรวมยอดเอง
 *
 * @param {(name:string)=>string|null} resolveProvince
 */
export async function fetchHighwayTraffic(resolveProvince) {
  const url = `${CKAN}/datastore_search?resource_id=${DOH_VK_PROVINCE_RESOURCE}&limit=5000`
  const payload = await fetchJson(url, { label: 'doh:vk-province' })
  if (!payload.success) throw new Error('CKAN datastore_search ของกรมทางหลวงล้มเหลว')

  const records = payload.result.records ?? []
  const byProvince = new Map()

  for (const row of records) {
    const geocode = resolveProvince(row['จังหวัด'])
    if (!geocode) continue

    const lanes = parseNumber(row['จำนวนช่องจราจร'])
    const distance = parseNumber(row['ระยะทาง'])

    // คอลัมน์ที่เหลือคือระยะทาง-คันของรถแต่ละประเภท รวมเป็น veh-km ทั้งหมด
    let vehicleKm = 0
    for (const [key, value] of Object.entries(row)) {
      if (key === '_id' || key === 'จังหวัด' || key === 'จำนวนช่องจราจร' || key === 'ระยะทาง') continue
      vehicleKm += parseNumber(value) ?? 0
    }

    if (!byProvince.has(geocode)) {
      byProvince.set(geocode, { highway_km: 0, vehicle_km: 0, lane_km: 0 })
    }
    const acc = byProvince.get(geocode)
    acc.highway_km += distance ?? 0
    acc.vehicle_km += vehicleKm
    acc.lane_km += (distance ?? 0) * (lanes ?? 0)
  }

  // แปลง lane_km เป็นจำนวนช่องจราจรเฉลี่ยถ่วงน้ำหนักด้วยระยะทาง
  for (const acc of byProvince.values()) {
    acc.avg_lanes = acc.highway_km > 0 ? acc.lane_km / acc.highway_km : null
    delete acc.lane_km
  }

  return byProvince
}

function overpassQuery(isoCode) {
  const sets = OSM_ROAD_CLASSES.map(
    (cls, i) => `way["highway"="${cls}"](area.a)->.r${i};`,
  ).join('\n')
  const outputs = OSM_ROAD_CLASSES.map((_, i) => `.r${i} out count;`).join('\n')
  return `[out:json][timeout:180];
area["ISO3166-2"="${isoCode}"]->.a;
${sets}
node["highway"="traffic_signals"](area.a)->.j;
${outputs}
.j out count;`
}

/**
 * ลักษณะโครงข่ายถนนรายจังหวัดจาก OpenStreetMap
 *
 * นับ "จำนวนเส้นทาง" ต่อชั้นถนน ไม่ใช่ความยาว เพราะการดึง geometry ของทั้งประเทศ
 * หนักเกินไปสำหรับ Overpass สาธารณะ — จำนวนเส้นทางก็สะท้อนความหนาแน่นโครงข่ายได้ในระดับที่ใช้งานได้
 *
 * ถ้าจังหวัดไหนดึงไม่สำเร็จ จะใส่ null แล้วไปต่อ ไม่ล้มทั้ง pipeline
 * เพราะ Overpass สาธารณะล่ม/ถูก rate-limit เป็นเรื่องปกติ
 */
export async function fetchOsmRoadProfile(provinces) {
  const byProvince = new Map()
  let failed = 0

  for (const [index, province] of provinces.entries()) {
    const isoCode = `TH-${province.geocode}`
    const body = overpassQuery(isoCode)

    try {
      const buf = await fetchCached(OVERPASS, {
        method: 'POST',
        body: `data=${encodeURIComponent(body)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        label: `overpass:${isoCode}`,
        timeoutMs: 240_000,
        retries: 2,
      })
      const payload = JSON.parse(buf.toString('utf8'))
      const counts = (payload.elements ?? [])
        .filter((e) => e.type === 'count')
        .map((e) => Number(e.tags?.ways ?? e.tags?.nodes ?? e.tags?.total ?? 0))

      if (counts.length !== OSM_ROAD_CLASSES.length + 1) {
        throw new Error(`Overpass คืน count มา ${counts.length} ชุด แต่คาดว่า ${OSM_ROAD_CLASSES.length + 1}`)
      }

      const profile = {}
      OSM_ROAD_CLASSES.forEach((cls, i) => {
        profile[`osm_${cls}_ways`] = counts[i]
      })
      profile.osm_traffic_signals = counts[counts.length - 1]
      byProvince.set(province.geocode, profile)
    } catch (err) {
      failed++
      console.warn(`  ⚠️ Overpass ${isoCode} (${province.name_th}) ไม่สำเร็จ: ${err.message}`)
      byProvince.set(province.geocode, null)
    }

    if ((index + 1) % 10 === 0) console.log(`  OSM ${index + 1}/${provinces.length} ...`)
    await sleep(2000) // เกรงใจ Overpass สาธารณะ
  }

  if (failed > 0) {
    console.warn(`  ⚠️ OSM ดึงไม่สำเร็จ ${failed}/${provinces.length} จังหวัด — feature กลุ่มนี้จะเป็น null`)
  }
  return byProvince
}
