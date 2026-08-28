import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const ROOT = path.resolve(here, '..')
export const DIR = {
  raw: path.join(ROOT, 'data', 'raw'),
  reference: path.join(ROOT, 'data', 'reference'),
  processed: path.join(ROOT, 'data', 'processed'),
}

/** ช่วงข้อมูล: ปี พ.ศ. 2565-2569 */
export const YEARS_BE = [2565, 2566, 2567, 2568, 2569]
export const START_DATE = '2022-01-01'

/** ThaiRSC — API จริงเบื้องหลัง SPA ของ thairsc.com (ไม่ต้องใช้ token) */
export const THAIRSC = {
  base: 'https://thairscapi.rvpeservice.com/api',
  provinceList: '/secondary/get_thailand_stats',
  statProvince: '/province/GetStatProvince',
  accidentPerDistrict: '/province/GetAccidentperDistrict',
  nationalSummary: '/main/section1_1',
}

/** data.go.th CKAN */
export const CKAN = 'https://data.go.th/api/3/action'

/**
 * RTDDI (ระบบบูรณาการข้อมูลการตายจากอุบัติเหตุทางถนน 3 ฐาน)
 * schema ต่างกันทุกปี -> ดู `columns` ของแต่ละปี
 * หมายเหตุ: คอลัมน์พิกัดสลับกันในไฟล์ต้นทาง (คอลัมน์ชื่อ lat เก็บ longitude)
 */
export const RTDDI_RESOURCES = [
  {
    yearBE: 2565,
    yearAD: 2022,
    resourceId: '5af00f52-ed10-409e-b549-cbf169f52b0d',
    file: '_2565.csv',
    columns: { date: 'Dead Date Final', dateFormat: 'dmy', province: 'จ.ที่เสียชีวิต', district: 'Acc Dist', lonCol: 'Acc La', latCol: 'Acclong', icd: 'Ncause', vehicle: 'Vehicle Merge Final', age: 'Age', sex: 'Sex' },
  },
  {
    yearBE: 2566,
    yearAD: 2023,
    resourceId: 'd1ab8a36-c5f7-4efb-b613-63310054b0bc',
    file: '_2566.csv',
    columns: { date: 'Dead Date Final', dateFormat: 'dmy', province: 'จ.ที่เสียชีวิต', district: 'Acc Dist', lonCol: 'Acc La', latCol: 'Acclong', icd: 'Ncause', vehicle: 'Vehicle Merge Final', age: 'Age', sex: 'Sex' },
  },
  {
    yearBE: 2567,
    yearAD: 2024,
    resourceId: '045f0036-6756-4c53-8ea6-d201b6ba6650',
    file: '_2567.csv',
    columns: { date: 'Dead Date Final', dateFormat: 'dmy', province: 'จ.ที่เสียชีวิต', district: 'acc_district_name', lonCol: 'Acc La', latCol: 'Acclong', icd: 'Ncause', vehicle: 'Vehicle Merge Final', age: 'Age', sex: 'Sex' },
  },
  {
    yearBE: 2568,
    yearAD: 2025,
    resourceId: '98c51d89-816b-4ce3-8b7f-648d5723e093',
    file: '_2568.csv',
    columns: { date: 'Dead Date', dateFormat: 'iso', province: 'จ.ที่เสียชีวิต', district: 'acc_district_name', lonCol: 'Acc La', latCol: 'Acclong', icd: 'Ncause', vehicle: 'Vehicle Merge Final', age: 'Age', sex: 'Sex' },
  },
  {
    yearBE: 2569,
    yearAD: 2026,
    resourceId: '580c0ba5-bc98-46fc-bb8d-961b1bde8f76',
    file: '_2026.csv',
    columns: { date: 'DeadDate_EN', dateFormat: 'iso', province: 'Dead_Prov', district: 'Acc_District', lonCol: 'Acc_Lat', latCol: 'Acc_long', icd: 'ICD_10', vehicle: 'Vehicle', age: 'Age', sex: 'Sex' },
  },
]

export const RTDDI_PACKAGE = 'rtddi'
export const RTDDI_DATASET_UUID = 'f5804870-7dc2-42df-86f3-769d6cc2ae23'

/**
 * อุบัติเหตุบนโครงข่ายถนนของกระทรวงคมนาคม (ทางหลวง + ทางหลวงชนบท + ทางด่วน)
 * แหล่ง label หลัก — มีอุบัติเหตุทุกระดับความรุนแรง พร้อมลักษณะทางและสภาพอากาศ ณ จุดเกิดเหตุ
 * หมายเหตุ: ไม่ระบุ dateFormat ไว้ตรงนี้ เพราะแต่ละปีใช้คนละแบบและเปลี่ยนได้อีก
 *           ให้ detectDateFormat() เดาจากข้อมูลจริงตอน parse แทน
 */
export const MOT_DATASET_UUID = '7e077ffd-dc4f-4dc6-a71c-0813726f3c12'
export const MOT_RESOURCES = [
  { yearBE: 2565, yearAD: 2022, resourceId: '733b7874-bd5f-44b9-b271-650890b061f2', file: 'accident2022.csv' },
  { yearBE: 2566, yearAD: 2023, resourceId: '661f2ead-1f28-4cd9-8a67-1bef76b33ef6', file: 'accident2023.csv' },
  { yearBE: 2567, yearAD: 2024, resourceId: '83e9fae0-5f33-45e7-9a6d-6d5ad2060a08', file: 'accident2024.csv' },
  { yearBE: 2568, yearAD: 2025, resourceId: 'e1db5e93-2b70-4ee4-b6d7-7ead76d14a09', file: 'accident2025.csv' },
  { yearBE: 2569, yearAD: 2026, resourceId: '4625b7aa-99a4-4dfb-9a0f-6402814d0f2c', file: 'accident2026.csv' },
]

/**
 * ชื่อคอลัมน์ MOT เปลี่ยนไปมาระหว่างปี — เก็บชื่อที่เป็นไปได้ทั้งหมด แล้วให้ตัว parser เลือกอันที่เจอ
 * ตัวแรกในลิสต์คือชื่อที่ใช้ในปีล่าสุด
 */
export const MOT_COLUMNS = {
  year: ['ปีที่เกิดเหตุ'],
  date: ['วันที่เกิดเหตุ'],
  time: ['เวลา'],
  agency: ['หน่วยงาน'],
  routeId: ['รหัสสายทาง'],
  routeName: ['สายทาง'],
  km: ['ก.ม.', 'KM'],
  province: ['จังหวัด'],
  roadGeometry: ['บริเวณที่เกิดเหตุ/ลักษณะทาง', 'บริเวณที่เกิดเหตุ'],
  cause: ['มูลเหตุสันนิษฐาน'],
  crashType: ['ลักษณะการเกิดอุบัติเหตุ', 'ลักษณะการเกิดเหตุ'],
  weather: ['สภาพอากาศ'],
  lat: ['LATITUDE'],
  lon: ['LONGITUDE'],
  dead: ['จำนวนผู้เสียชีวิต', 'ผู้เสียชีวิต'],
  injuredSevere: ['จำนวนผู้บาดเจ็บสาหัส', 'ผู้บาดเจ็บสาหัส'],
  injuredMinor: ['จำนวนผู้บาดเจ็บเล็กน้อย', 'ผู้บาดเจ็บเล็กน้อย'],
  injuredTotal: ['รวมจำนวนผู้บาดเจ็บ'],
  vehicleFirst: ['รถคันที่1'],
}

/** กรมทางหลวง: ปริมาณการเดินทางบนทางหลวงจำแนกตามจังหวัด (อ่านผ่าน CKAN datastore เท่านั้น) */
export const DOH_VK_PROVINCE_RESOURCE = '67d06af6-7237-4631-9afd-80efa9fb8b18'

export const OPEN_METEO = 'https://archive-api.open-meteo.com/v1/archive'
export const OPEN_METEO_DAILY = [
  'precipitation_sum',
  'rain_sum',
  'precipitation_hours',
  'temperature_2m_max',
  'temperature_2m_min',
  'windspeed_10m_max',
]

export const HOLIDAY_ICS =
  'https://calendar.google.com/calendar/ical/th.th%23holiday%40group.v.calendar.google.com/public/basic.ics'

export const OVERPASS = 'https://overpass-api.de/api/interpreter'
export const OSM_ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary']

export const USER_AGENT =
  'thai-road-accident-risk/1.0 (research pipeline; contact via repo owner)'

/** เกณฑ์ feature สภาพอากาศ */
export const RAIN_MM_THRESHOLD = 1.0
export const HEAVY_RAIN_MM_THRESHOLD = 35.0

/** ช่วงเทศกาล (เดือน, วัน) แบบรวมปลายทาง */
export const FESTIVAL_WINDOWS = {
  songkran: { from: [4, 11], to: [4, 17] },
  newyear: { from: [12, 29], to: [1, 4] },
}

/** ตัดข้อมูล N วันล่าสุดออกจาก training ได้ เพราะ RTDDI มี reporting lag */
export const REPORTING_LAG_DAYS = 90
