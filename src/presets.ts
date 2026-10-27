import type { CaseKey } from './model'

/** Inner case dimensions in mm; `unknown` lists values the source does not give (filled with 0 or assumed). */
export interface Preset {
  name: string
  group: string
  values: Record<CaseKey, number>
  unknown: CaseKey[]
  /** Saved by the user in this browser. */
  user?: boolean
}

/** Inner sizes in mm; null = not published (radii become 0, the floor size is assumed equal to the top). */
type Row = [group: string, name: string, length: number, width: number, bottomL: number | null, bottomW: number | null,
  depth: number, lidDepth: number | null, radius: number | null, bottomRadius: number | null]

// Peli: interior L × W, base and lid depth as published (peli.com AU, cm × 10).
// Euro pallet (1200 × 800) with stacked wooden collars, 200 mm each, 1160 × 760 mm inside (Rotom 38135HTKD); no lid.
const ROWS: Row[] = [
  ['Peli Protector', 'Peli 1120', 185, 121, null, null, 65, 13, null, null],
  ['Peli Protector', 'Peli 1150', 211, 147, null, null, 73, 19, null, null],
  ['Peli Protector', 'Peli 1170', 268, 153, null, null, 53, 27, null, null],
  ['Peli Protector', 'Peli 1200', 236, 181, null, null, 74, 30, null, null],
  ['Peli Protector', 'Peli 1300', 233, 178, null, null, 126, 30, null, null],
  ['Peli Protector', 'Peli 1400', 300, 225, null, null, 102, 30, null, null],
  ['Peli Protector', 'Peli 1430', 344, 146, null, null, 246, 51, null, null],
  ['Peli Protector', 'Peli 1440', 434, 191, null, null, 356, 51, null, null],
  ['Peli Protector', 'Peli 1450', 372, 260, null, null, 111, 44, null, null],
  ['Peli Protector', 'Peli 1460', 471, 252, null, null, 153, 125, null, null],
  ['Peli Protector', 'Peli 1470', 399, 272, null, null, 61, 37, null, null],
  ['Peli Protector', 'Peli 1490', 451, 289, null, null, 67, 38, null, null],
  ['Peli Protector', 'Peli 1495', 479, 333, null, null, 68, 28, null, null],
  ['Peli Protector', 'Peli 1500', 425, 284, null, null, 109, 46, null, null],
  ['Peli Protector', 'Peli 1510', 502, 279, null, null, 147, 45, null, null],
  ['Peli Protector', 'Peli 1520', 459, 327, null, null, 125, 45, null, null],
  ['Peli Protector', 'Peli 1550', 473, 360, null, null, 149, 44, null, null],
  ['Peli Protector', 'Peli 1560', 506, 380, null, null, 178, 51, null, null],
  ['Peli Protector', 'Peli 1600', 546, 420, null, null, 155, 44, null, null],
  ['Peli Protector', 'Peli 1610', 553, 424, null, null, 218, 52, null, null],
  ['Peli Protector', 'Peli 1620', 546, 417, null, null, 267, 51, null, null],
  ['Peli Protector', 'Peli 1630', 704, 533, null, null, 308, 83, null, null],
  ['Peli Protector', 'Peli 1640', 602, 610, null, null, 302, 51, null, null],
  ['Peli Protector', 'Peli 1650', 726, 445, null, null, 225, 46, null, null],
  ['Peli Protector', 'Peli 1660', 716, 499, null, null, 359, 89, null, null],
  ['Peli Protector', 'Peli 1670', 714, 419, null, null, 188, 46, null, null],
  ['Peli Protector', 'Peli 1690', 765, 638, null, null, 308, 73, null, null],
  ['Peli Protector', 'Peli 1700', 908, 343, null, null, 89, 44, null, null],
  ['Peli Protector', 'Peli 1720', 1067, 343, null, null, 89, 44, null, null],
  ['Peli Protector', 'Peli 1730', 864, 610, null, null, 254, 64, null, null],
  ['Peli Protector', 'Peli 1740', 1041, 328, null, null, 243, 65, null, null],
  ['Peli Protector', 'Peli 1750', 1283, 343, null, null, 89, 44, null, null],
  ['Peli Protector', 'Peli 1770', 1386, 396, null, null, 171, 42, null, null],
  ['Peli Protector', 'Peli 1780', 1044, 547, null, null, 185, 193, null, null],
  ['Peli Air', 'Peli 1465 Air', 473, 254, null, null, 152, 125, null, null],
  ['Peli Air', 'Peli 1485 Air', 451, 259, null, null, 110, 46, null, null],
  ['Peli Air', 'Peli 1506 Air', 475, 239, null, null, 147, 51, null, null],
  ['Peli Air', 'Peli 1507 Air', 385, 289, null, null, 165, 52, null, null],
  ['Peli Air', 'Peli 1525 Air', 521, 287, null, null, 121, 51, null, null],
  ['Peli Air', 'Peli 1535 Air', 518, 284, null, null, 132, 51, null, null],
  ['Peli Air', 'Peli 1555 Air', 584, 324, null, null, 140, 51, null, null],
  ['Peli Air', 'Peli 1556 Air', 549, 273, null, null, 177, 51, null, null],
  ['Peli Air', 'Peli 1557 Air', 440, 330, null, null, 196, 51, null, null],
  ['Peli Air', 'Peli 1595 Air', 648, 379, null, null, 176, 51, null, null],
  ['Peli Air', 'Peli 1605 Air', 660, 356, null, null, 162, 51, null, null],
  ['Peli Air', 'Peli 1606 Air', 623, 312, null, null, 209, 51, null, null],
  ['Peli Air', 'Peli 1607 Air', 535, 402, null, null, 244, 51, null, null],
  ['Peli Air', 'Peli 1615 Air', 752, 394, null, null, 187, 51, null, null],
  ['Peli Air', 'Peli 1626 Air', 715, 358, null, null, 247, 51, null, null],
  ['Peli Air', 'Peli 1637 Air', 595, 446, null, null, 284, 51, null, null],
  ['Peli Air', 'Peli 1745 Air', 1118, 426, null, null, 138, 64, null, null],
  ['Peli Air', 'Peli 1755 Air', 1397, 356, null, null, 140, 64, null, null],
  ['Peli Storm', 'Peli iM2050', 241, 191, null, null, 70, 38, null, null],
  ['Peli Storm', 'Peli iM2075', 241, 191, null, null, 146, 38, null, null],
  ['Peli Storm', 'Peli iM2100', 330, 234, null, null, 102, 51, null, null],
  ['Peli Storm', 'Peli iM2200', 381, 267, null, null, 102, 51, null, null],
  ['Peli Storm', 'Peli iM2300', 432, 297, null, null, 107, 51, null, null],
  ['Peli Storm', 'Peli iM2306', 432, 160, null, null, 107, 51, null, null],
  ['Peli Storm', 'Peli iM2370', 462, 307, null, null, 89, 43, null, null],
  ['Peli Storm', 'Peli iM2400', 457, 330, null, null, 119, 51, null, null],
  ['Peli Storm', 'Peli iM2450', 457, 330, null, null, 163, 51, null, null],
  ['Peli Storm', 'Peli iM2500', 521, 292, null, null, 132, 51, null, null],
  ['Peli Storm', 'Peli iM2600', 508, 356, null, null, 145, 51, null, null],
  ['Peli Storm', 'Peli iM2620', 508, 356, null, null, 203, 51, null, null],
  ['Peli Storm', 'Peli iM2700', 559, 432, null, null, 152, 51, null, null],
  ['Peli Storm', 'Peli iM2720', 559, 432, null, null, 203, 51, null, null],
  ['Peli Storm', 'Peli iM2750', 559, 432, null, null, 272, 51, null, null],
  ['Peli Storm', 'Peli iM2875', 572, 536, null, null, 239, 51, null, null],
  ['Peli Storm', 'Peli iM2950', 737, 457, null, null, 216, 51, null, null],
  ['Peli Storm', 'Peli iM2975', 737, 457, null, null, 300, 51, null, null],
  ['Peli Storm', 'Peli iM3075', 757, 528, null, null, 349, 102, null, null],
  ['Peli Storm', 'Peli iM3100', 927, 356, null, null, 102, 51, null, null],
  ['Peli Storm', 'Peli iM3200', 1118, 356, null, null, 102, 51, null, null],
  ['Peli Storm', 'Peli iM3220', 1118, 356, null, null, 165, 51, null, null],
  ['Peli Storm', 'Peli iM3300', 1283, 356, null, null, 102, 51, null, null],
  ['Euro pallet', 'Euro pallet + 1 collar', 1160, 760, 1160, 760, 200, 0, 0, 0],
  ['Euro pallet', 'Euro pallet + 2 collars', 1160, 760, 1160, 760, 400, 0, 0, 0],
  ['Euro pallet', 'Euro pallet + 3 collars', 1160, 760, 1160, 760, 600, 0, 0, 0],
  ['Euro pallet', 'Euro pallet + 4 collars', 1160, 760, 1160, 760, 800, 0, 0, 0],
]

export const PRESETS: Preset[] = ROWS.map(([group, name, l, w, bottomL, bottomW, depth, lidDepth, radius, bottomRadius]) => {
  const given = { topL: l, topW: w, bottomL, bottomW, depth, lidDepth, radius, bottomRadius }
  const unknown = (Object.keys(given) as CaseKey[]).filter(k => given[k] === null)
  const values = { ...given, bottomL: bottomL ?? l, bottomW: bottomW ?? w, lidDepth: lidDepth ?? 0, radius: radius ?? 0, bottomRadius: bottomRadius ?? 0 }
  return { name, group, values, unknown }
})

const KEY = 'incase.presets'

/** Presets the user saved in this browser. */
export function userPresets(): Preset[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

export const saveUserPresets = (presets: Preset[]) => localStorage.setItem(KEY, JSON.stringify(presets))
