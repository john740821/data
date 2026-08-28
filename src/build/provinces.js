import fs from 'node:fs'
import path from 'node:path'
import { DIR } from '../config.js'
import { fetchProvinceMaster, fetchProvinceStat } from '../sources/thairsc.js'
import { makeProvinceResolver } from '../lib/provinceResolve.js'
import { fetchAllMot } from '../sources/motAccident.js'

const REFERENCE_FILE = path.join(DIR.reference, 'provinces.json')

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * สร้างไฟล์อ้างอิงจังหวัด: geocode, ชื่อ, จุดศูนย์กลาง, ตัวชี้วัดการเปิดรับความเสี่ยง
 * จุดศูนย์กลางคำนวณจาก median พิกัดอุบัติเหตุจริงของ MOT (พิกัดครบ ~99%)
 * ใช้ median ไม่ใช่ mean เพราะทนต่อพิกัดหลุดหรือพิมพ์ผิดได้ดีกว่า
 */
export async function buildProvinces({ refresh = false } = {}) {
  if (!refresh && fs.existsSync(REFERENCE_FILE)) {
    return JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'))
  }

  console.log('สร้างไฟล์อ้างอิงจังหวัด ...')
  const master = await fetchProvinceMaster()
  if (master.length !== 77) {
    throw new Error(`ThaiRSC คืนจังหวัดมา ${master.length} รายการ ไม่ใช่ 77 — ตรวจ API ก่อนไปต่อ`)
  }

  const resolve = makeProvinceResolver(master)
  const { events } = await fetchAllMot(resolve)

  const coordsByProvince = new Map()
  for (const e of events) {
    if (e.lat === null) continue
    if (!coordsByProvince.has(e.geocode)) coordsByProvince.set(e.geocode, { lat: [], lon: [] })
    const bucket = coordsByProvince.get(e.geocode)
    bucket.lat.push(e.lat)
    bucket.lon.push(e.lon)
  }

  console.log('  ดึงตัวชี้วัดรายจังหวัดจาก ThaiRSC ...')
  const provinces = []
  for (const p of master) {
    const bucket = coordsByProvince.get(p.geocode)
    const stat = await fetchProvinceStat(p.geocode)
    provinces.push({
      geocode: p.geocode,
      name_th: p.name_th,
      lat: bucket ? median(bucket.lat) : null,
      lon: bucket ? median(bucket.lon) : null,
      coord_samples: bucket ? bucket.lat.length : 0,
      population: stat.population,
      motorcycles: stat.motorcycles,
      cars: stat.cars,
      area_km2: stat.area_km2,
    })
  }

  const missingCentroid = provinces.filter((p) => p.lat === null)
  if (missingCentroid.length > 0) {
    throw new Error(
      `หาจุดศูนย์กลางไม่ได้ ${missingCentroid.length} จังหวัด: ` +
        missingCentroid.map((p) => p.name_th).join(', '),
    )
  }

  const outOfRange = provinces.filter((p) => p.lat < 5 || p.lat > 21 || p.lon < 96 || p.lon > 106)
  if (outOfRange.length > 0) {
    throw new Error(`จุดศูนย์กลางหลุดขอบเขตประเทศไทย: ${outOfRange.map((p) => p.name_th).join(', ')}`)
  }

  fs.mkdirSync(DIR.reference, { recursive: true })
  fs.writeFileSync(REFERENCE_FILE, JSON.stringify(provinces, null, 2), 'utf8')
  console.log(`  เขียน ${REFERENCE_FILE} (${provinces.length} จังหวัด)`)
  return provinces
}

export function loadProvinces() {
  if (!fs.existsSync(REFERENCE_FILE)) {
    throw new Error(`ยังไม่มี ${REFERENCE_FILE} — รัน \`npm run provinces\` ก่อน`)
  }
  return JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'))
}

export { REFERENCE_FILE }
