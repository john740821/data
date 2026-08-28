import { buildProvinces } from './build/provinces.js'
import { buildPanel } from './build/panel.js'
import { writeHotspots } from './build/hotspots.js'

const command = process.argv[2] ?? 'all'
const flags = new Set(process.argv.slice(3))

// ข้าม OpenStreetMap เป็นค่าตั้งต้น — Overpass สาธารณะ rate-limit หนักมาก
// (ทดสอบจริงแล้วติดตั้งแต่จังหวัดที่ 3 จาก 77 ต้องรอเป็นชั่วโมง)
// ลักษณะโครงข่ายถนนได้จากกรมทางหลวงอยู่แล้ว (highway_km, avg_lanes, vehicle_km)
// ใครอยากได้ feature osm_* เพิ่ม ค่อยใส่ --with-osm เอง
const skipOsm = !flags.has('--with-osm')

function usage() {
  console.log(`
วิธีใช้: node src/cli.js <คำสั่ง> [--with-osm]

  provinces   สร้าง data/reference/provinces.json
  ingest      ดึงข้อมูลทุกแหล่งเข้า cache (data/raw/) ไม่เขียนไฟล์ผลลัพธ์
  build       สร้าง panel.csv + hotspots.csv + feature_spec.json
  all         เหมือน build

  --with-osm  ดึงโครงข่ายถนนจาก OpenStreetMap เพิ่ม (ช้ามาก Overpass มัก rate-limit)
`)
}

const started = Date.now()

try {
  switch (command) {
    case 'provinces': {
      const provinces = await buildProvinces({ refresh: true })
      console.log(`เสร็จ: ${provinces.length} จังหวัด`)
      break
    }

    case 'ingest':
    case 'build':
    case 'all': {
      // เดินทางเดียวกันทั้งสามคำสั่ง เพราะ fetch ทุกตัวมี cache อยู่แล้ว
      // ต่างกันแค่ 'ingest' ไม่เขียนไฟล์ผลลัพธ์ — แค่ดึงข้อมูลลง cache แล้วตรวจว่า join ได้จริง
      const isIngestOnly = command === 'ingest'
      const { motEvents, spec } = await buildPanel({ skipOsm, write: !isIngestOnly })

      if (!isIngestOnly) {
        const provinces = await buildProvinces()
        writeHotspots(motEvents, provinces)
      }

      console.log(
        `\nสรุป: ${spec.rows} แถว | ${spec.accidents_total} เหตุการณ์ | ` +
          `${spec.date_start} → ${spec.date_end} | OSM ${spec.osm_coverage}`,
      )
      break
    }

    default:
      usage()
      process.exit(command === 'help' || command === '--help' ? 0 : 1)
  }

  console.log(`ใช้เวลา ${((Date.now() - started) / 1000).toFixed(1)} วินาที`)
} catch (err) {
  console.error(`\n❌ ล้มเหลว: ${err.message}`)
  if (process.env.DEBUG) console.error(err.stack)
  process.exit(1)
}
