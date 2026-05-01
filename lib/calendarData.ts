import { CollectionType, DayEntry, MonthlyCalendar } from '@/types';

interface WeeklyItem {
  day: number;         // 0=日, 1=月, ..., 6=土
  types: CollectionType[];
}

interface MonthlyItem {
  day: number;         // 0=日, 1=月, ..., 6=土
  nth: number;         // 1=第1, 2=第2, 3=第3, 4=第4
  types: CollectionType[];
}

interface ScheduleConfig {
  weekly: WeeklyItem[];
  monthly: MonthlyItem[];
}

// A: 可燃=火・金, プラ=金, 枝葉=火, 資源=月
const scheduleA: ScheduleConfig = {
  weekly: [
    { day: 2, types: ['burnable', 'branches'] },
    { day: 5, types: ['burnable', 'plastic'] },
  ],
  monthly: [
    { day: 1, nth: 1, types: ['cans', 'pet'] },
    { day: 1, nth: 2, types: ['bottlesBatteries'] },
    { day: 1, nth: 3, types: ['paper', 'pet'] },
    { day: 1, nth: 4, types: ['nonBurnable'] },
  ],
};

// B: 可燃=月・木, プラ=木, 枝葉=月, 資源=金
const scheduleB: ScheduleConfig = {
  weekly: [
    { day: 1, types: ['burnable', 'branches'] },
    { day: 4, types: ['burnable', 'plastic'] },
  ],
  monthly: [
    { day: 5, nth: 1, types: ['cans', 'pet'] },
    { day: 5, nth: 2, types: ['bottlesBatteries'] },
    { day: 5, nth: 3, types: ['paper', 'pet'] },
    { day: 5, nth: 4, types: ['nonBurnable'] },
  ],
};

// C: 可燃=水・土, プラ=土, 枝葉=水, 資源=火
const scheduleC: ScheduleConfig = {
  weekly: [
    { day: 3, types: ['burnable', 'branches'] },
    { day: 6, types: ['burnable', 'plastic'] },
  ],
  monthly: [
    { day: 2, nth: 1, types: ['cans', 'pet'] },
    { day: 2, nth: 2, types: ['bottlesBatteries'] },
    { day: 2, nth: 3, types: ['paper', 'pet'] },
    { day: 2, nth: 4, types: ['nonBurnable'] },
  ],
};

// D: 信更（牧田・信級）= 市カレンダー41番
// 可燃=毎火, プラ=毎金, 不燃=第1水, ペット=第2・4水, 缶=第2土, ビン電池=第3土, 紙=第4土
const scheduleD: ScheduleConfig = {
  weekly: [
    { day: 2, types: ['burnable', 'branches'] },
    { day: 5, types: ['plastic'] },
  ],
  monthly: [
    { day: 3, nth: 1, types: ['nonBurnable'] },
    { day: 3, nth: 2, types: ['pet'] },
    { day: 6, nth: 2, types: ['cans'] },
    { day: 6, nth: 3, types: ['bottlesBatteries'] },
    { day: 3, nth: 4, types: ['pet'] },
    { day: 6, nth: 4, types: ['paper'] },
  ],
};

export const schedules: Record<'A' | 'B' | 'C' | 'D', ScheduleConfig> = {
  A: scheduleA,
  B: scheduleB,
  C: scheduleC,
  D: scheduleD,
};

function getNthWeekday(year: number, month: number, dayOfWeek: number, n: number): number | null {
  let count = 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() === dayOfWeek) {
      count++;
      if (count === n) return d;
    }
  }
  return null;
}

export function generateMonthCalendar(
  year: number,
  month: number,
  scheduleType: 'A' | 'B' | 'C' | 'D'
): MonthlyCalendar {
  const schedule = schedules[scheduleType];
  const daysInMonth = new Date(year, month, 0).getDate();

  // 月ごとの収集日を事前計算（同一日に複数種別が重なる場合もマージ）
  const monthlyMap = new Map<number, CollectionType[]>();
  for (const item of schedule.monthly) {
    const d = getNthWeekday(year, month, item.day, item.nth);
    if (d !== null) {
      if (!monthlyMap.has(d)) monthlyMap.set(d, []);
      monthlyMap.get(d)!.push(...item.types);
    }
  }

  const entries: DayEntry[] = [];

  for (let date = 1; date <= daysInMonth; date++) {
    const dow = new Date(year, month - 1, date).getDay();
    const types: CollectionType[] = [];

    for (const item of schedule.weekly) {
      if (item.day === dow) types.push(...item.types);
    }

    const monthly = monthlyMap.get(date);
    if (monthly) types.push(...monthly);

    if (types.length > 0) entries.push({ date, dayOfWeek: dow, types });
  }

  return { year, month, entries };
}

export function generateYearCalendar(year: number, scheduleType: 'A' | 'B' | 'C' | 'D'): MonthlyCalendar[] {
  return Array.from({ length: 12 }, (_, i) => generateMonthCalendar(year, i + 1, scheduleType));
}

export const collectionTypeLabels: Record<CollectionType, string> = {
  burnable: '可燃ごみ',
  plastic: '資源プラスチック',
  branches: '枝葉',
  cans: '缶',
  pet: 'ペット',
  bottlesBatteries: 'ビン・電池',
  paper: '紙',
  nonBurnable: '不燃ごみ',
};

export const collectionTypeColors: Record<CollectionType, { bg: string; text: string; border: string }> = {
  burnable:        { bg: '#fef2f2', text: '#dc2626', border: '#fca5a5' },
  plastic:         { bg: '#fefce8', text: '#ca8a04', border: '#fde047' },
  branches:        { bg: '#f0fdf4', text: '#16a34a', border: '#86efac' },
  cans:            { bg: '#f0f9ff', text: '#0284c7', border: '#7dd3fc' },
  pet:             { bg: '#eff6ff', text: '#2563eb', border: '#93c5fd' },
  bottlesBatteries:{ bg: '#faf5ff', text: '#7c3aed', border: '#c4b5fd' },
  paper:           { bg: '#fff7ed', text: '#ea580c', border: '#fdba74' },
  nonBurnable:     { bg: '#f8fafc', text: '#475569', border: '#cbd5e1' },
};
