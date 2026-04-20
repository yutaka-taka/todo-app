import { CollectionType, DayEntry, MonthlyCalendar } from '@/types';

// スケジュール設定
// burnableDays: 可燃ごみの曜日 (0=日,1=月,...,6=土)
// plasticDay:   その日に可燃と同時に資源プラスチックを収集 (burnableDays のうち1つ)
// branchesDay:  その日に可燃と同時に枝葉を収集 (burnableDays のうち1つ)
// resourceDay:  月4回の資源収集(缶/びん/紙/不燃)を行う曜日
interface ScheduleConfig {
  burnableDays: number[];
  plasticDay: number;
  branchesDay: number;
  resourceDay: number;
}

// A: 可燃=火・金, プラ=金, 枝葉=火, 資源=月
const scheduleA: ScheduleConfig = {
  burnableDays: [2, 5],
  plasticDay: 5,
  branchesDay: 2,
  resourceDay: 1,
};

// B: 可燃=月・木, プラ=木, 枝葉=月, 資源=金
const scheduleB: ScheduleConfig = {
  burnableDays: [1, 4],
  plasticDay: 4,
  branchesDay: 1,
  resourceDay: 5,
};

// C: 可燃=水・土, プラ=土, 枝葉=水, 資源=火
const scheduleC: ScheduleConfig = {
  burnableDays: [3, 6],
  plasticDay: 6,
  branchesDay: 3,
  resourceDay: 2,
};

export const schedules: Record<'A' | 'B' | 'C', ScheduleConfig> = {
  A: scheduleA,
  B: scheduleB,
  C: scheduleC,
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
  scheduleType: 'A' | 'B' | 'C'
): MonthlyCalendar {
  const schedule = schedules[scheduleType];
  const daysInMonth = new Date(year, month, 0).getDate();

  // 資源収集日（月4回）
  const cansDate = getNthWeekday(year, month, schedule.resourceDay, 1);          // 第1: 缶+ペット
  const bottlesDate = getNthWeekday(year, month, schedule.resourceDay, 2);       // 第2: ビン+電池
  const paperDate = getNthWeekday(year, month, schedule.resourceDay, 3);         // 第3: 紙+ペット
  const nonBurnableDate = getNthWeekday(year, month, schedule.resourceDay, 4);   // 第4: 不燃

  const entries: DayEntry[] = [];

  for (let date = 1; date <= daysInMonth; date++) {
    const dow = new Date(year, month - 1, date).getDay();
    const types: CollectionType[] = [];

    // 可燃ごみの日
    if (schedule.burnableDays.includes(dow)) {
      types.push('burnable');
      if (dow === schedule.plasticDay) types.push('plastic');
      if (dow === schedule.branchesDay) types.push('branches');
    }

    // 資源収集日（月ごとの曜日）
    if (date === cansDate) { types.push('cans'); types.push('pet'); }
    if (date === bottlesDate) types.push('bottlesBatteries');
    if (date === paperDate) { types.push('paper'); types.push('pet'); }
    if (date === nonBurnableDate) types.push('nonBurnable');

    if (types.length > 0) entries.push({ date, dayOfWeek: dow, types });
  }

  return { year, month, entries };
}

export function generateYearCalendar(year: number, scheduleType: 'A' | 'B' | 'C'): MonthlyCalendar[] {
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
