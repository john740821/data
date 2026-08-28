/**
 * แปลงชื่อจังหวัด/พิกัด/รหัสสายทาง จากข้อมูลดิบหลายแหล่ง ให้เป็น geocode มาตรฐาน
 * ใช้ร่วมกันระหว่าง RTDDI และ MOT เพราะทั้งคู่สะกดชื่อจังหวัดไม่นิ่งเหมือนกัน
 */

/** ทำให้ชื่อจังหวัดเทียบกันได้: ตัดช่องว่าง, ตัดคำนำหน้า, รวมรูปสระที่เขียนต่างกัน */
export function provinceKey(name) {
  if (!name) return ''
  let s = String(name).normalize('NFC').trim()
  s = s.replace(/^จังหวัด/, '').replace(/^จ\.\s*/, '')
  s = s.replace(/\s+/g, '')
  s = s.replace(/ฯ$/, '')
  s = s.replace(/ํา/g, 'ำ')
  s = s.replace(/[​‌‍﻿]/g, '')
  return s
}

/** ชื่อย่อ/ชื่อเรียกติดปาก ที่ไม่ใช่การสะกดผิด จึงเดาอัตโนมัติไม่ได้ ต้องระบุเอง */
const MANUAL_ALIASES = {
  กทม: 'กรุงเทพมหานคร',
  กรุงเทพ: 'กรุงเทพมหานคร',
  กรุงเทพฯ: 'กรุงเทพมหานคร',
  พระนคร: 'กรุงเทพมหานคร',
  อยุธยา: 'พระนครศรีอยุธยา',
  ศรีอยุธยา: 'พระนครศรีอยุธยา',
  บางกอก: 'กรุงเทพมหานคร',
  ประจวบ: 'ประจวบคีรีขันธ์',
  โคราช: 'นครราชสีมา',
}

/**
 * สร้างฟังก์ชัน map ชื่อจังหวัดดิบ -> geocode
 *
 * การจับคู่แบบหลวม (prefix/suffix) จะยอมรับก็ต่อเมื่อ**เจอผู้สมัครเพียงรายเดียว**
 * ถ้ากำกวมให้คืน null ไปเลย ดีกว่า map ผิดแล้วข้อมูลเพี้ยนเงียบ ๆ
 *
 * @param {{geocode:string,name_th:string}[]} master
 */
export function makeProvinceResolver(master) {
  const byKey = new Map()
  for (const p of master) byKey.set(provinceKey(p.name_th), p.geocode)
  for (const [alias, canonical] of Object.entries(MANUAL_ALIASES)) {
    const geocode = byKey.get(provinceKey(canonical))
    if (geocode) byKey.set(provinceKey(alias), geocode)
  }

  return function resolve(rawName) {
    const key = provinceKey(rawName)
    if (!key) return null

    const direct = byKey.get(key)
    if (direct) return direct

    if (key.length >= 4) {
      const matches = new Set()
      for (const [k, geocode] of byKey) {
        if (k.startsWith(key) || key.startsWith(k) || k.endsWith(key)) matches.add(geocode)
      }
      if (matches.size === 1) return [...matches][0]
    }
    return null
  }
}

/**
 * เรียนรู้ว่ารหัสสายทางขึ้นต้นด้วยอะไร แล้วอยู่จังหวัดไหน จากแถวที่ map สำเร็จแล้ว
 * ทางหลวงชนบทใช้อักษรย่อจังหวัดนำหน้า เช่น นธ.4011 = นราธิวาส, ปท.3020 = ปทุมธานี
 * สร้างจากข้อมูลเองแทนการ hard-code ตาราง 77 อักษรย่อ
 *
 * @param {{routeId:string|null, geocode:string}[]} mappedEvents
 */
export function buildRoutePrefixIndex(mappedEvents) {
  const counts = new Map()
  for (const e of mappedEvents) {
    if (!e.routeId) continue
    const m = String(e.routeId).match(/^([ก-๛]{2,4})\./)
    if (!m) continue
    const prefix = m[1]
    if (!counts.has(prefix)) counts.set(prefix, new Map())
    const inner = counts.get(prefix)
    inner.set(e.geocode, (inner.get(e.geocode) || 0) + 1)
  }

  const index = new Map()
  for (const [prefix, inner] of counts) {
    let total = 0
    let best = null
    let bestCount = 0
    for (const [geocode, n] of inner) {
      total += n
      if (n > bestCount) {
        bestCount = n
        best = geocode
      }
    }
    // ยอมรับเฉพาะที่เห็นบ่อยพอและชัดเจนว่าเป็นจังหวัดเดียว
    if (total >= 5 && bestCount / total >= 0.9) index.set(prefix, best)
  }
  return index
}

export function resolveByRoutePrefix(routeId, index) {
  if (!routeId) return null
  const m = String(routeId).match(/^([ก-๛]{2,4})\./)
  if (!m) return null
  return index.get(m[1]) ?? null
}

const GRID = 0.5

/**
 * สร้างตัวหาจังหวัดจากพิกัด ด้วย k-nearest-neighbour โหวต
 * อ้างอิงจากเหตุการณ์ที่ map จังหวัดสำเร็จแล้วและมีพิกัด (มีเป็นหมื่นจุด)
 * แม่นกว่าการหาจุดศูนย์กลางจังหวัดที่ใกล้ที่สุดมาก เพราะจังหวัดไทยหลายจังหวัดรูปร่างยาวรี
 *
 * @param {{lat:number, lon:number, geocode:string}[]} labelled
 */
export function makeCoordResolver(labelled, { k = 15 } = {}) {
  const buckets = new Map()
  const cellKey = (lat, lon) => `${Math.floor(lat / GRID)}:${Math.floor(lon / GRID)}`

  for (const p of labelled) {
    if (p.lat === null || p.lon === null) continue
    const key = cellKey(p.lat, p.lon)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(p)
  }

  return function resolveCoord(lat, lon) {
    if (lat === null || lon === null) return null

    // ขยายรัศมีทีละวงจนกว่าจะเจอจุดพอ
    let candidates = []
    for (let ring = 1; ring <= 4 && candidates.length < k; ring++) {
      candidates = []
      const cy = Math.floor(lat / GRID)
      const cx = Math.floor(lon / GRID)
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          const cell = buckets.get(`${cy + dy}:${cx + dx}`)
          if (cell) candidates.push(...cell)
        }
      }
    }
    if (candidates.length === 0) return null

    const scored = candidates
      .map((p) => ({ geocode: p.geocode, d: (p.lat - lat) ** 2 + (p.lon - lon) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)

    const votes = new Map()
    for (const s of scored) votes.set(s.geocode, (votes.get(s.geocode) || 0) + 1)

    let best = null
    let bestVotes = 0
    for (const [geocode, n] of votes) {
      if (n > bestVotes) {
        bestVotes = n
        best = geocode
      }
    }
    // ต้องชนะเกินครึ่ง ไม่งั้นถือว่าอยู่แถบชายแดนจังหวัด เดาไม่ได้
    return bestVotes / scored.length > 0.5 ? best : null
  }
}
