import { CollectionType, DayEntry, MonthlyCalendar } from '@/types';

interface ScheduleConfig {
  burnable: number[];
  recyclable: { weeks: number[]; day: number };
  paper: { weeks: number[]; day: number };
  nonBurnable: { week: number; day: number };
  hazardous: { week: number; day: number };
}

// Schedule A: 燃えるごみ=火・金, 資源缶びんペット=第2・4火, 古紙古布=第1・3金, 燃えないごみ=第3木, 有害=第1木
const scheduleA: ScheduleConfig = {
  burnable: [2, 5],
  recyclable: { weeks: [2, 4], day: 2 },
  paper: { weeks: [1, 3], day: 5 },
  nonBurnable: { week: 3, day: 4 },
  hazardous: { week: 1, day: 4 },
};

// Schedule B: 燃えるごみ=月・木, 資源缶びんペット=第2・4月, 古紙古布=第1・3木, 燃えないごみ=第3水, 有害=第1水
const scheduleB: ScheduleConfig = {
  burnable: [1, 4],
  recyclable: { weeks: [2, 4], day: 1 },
  paper: { weeks: [1, 3], day: 4 },
  nonBurnable: { week: 3, day: 3 },
  hazardous: { week: 1, day: 3 },
};

// Schedule C: 燃えるごみ=水・土, 資源缶びんペット=第2・4水, 古紙古布=第1・3土, 燃えないごみ=第3月, 有害=第1月
const scheduleC: ScheduleConfig = {
  burnable: [3, 6],
  recyclable: { weeks: [2, 4], day: 3 },
  paper: { weeks: [1, 3], day: 6 },
  nonBurnable: { week: 3, day: 1 },
  hazardous: { week: 1, day: 1 },
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

  // Precompute special days
  const recyclableDates = new Set<number>();
  const paperDates = new Set<number>();
  schedule.recyclable.weeks.forEach(w => {
    const d = getNthWeekday(year, month, schedule.recyclable.day, w);
    if (d) recyclableDates.add(d);
  });
  schedule.paper.weeks.forEach(w => {
    const d = getNthWeekday(year, month, schedule.paper.day, w);
    if (d) paperDates.add(d);
  });
  const nonBurnableDate = getNthWeekday(year, month, schedule.nonBurnable.day, schedule.nonBurnable.week);
  const hazardousDate = getNthWeekday(year, month, schedule.hazardous.day, schedule.hazardous.week);

  const entries: DayEntry[] = [];

  for (let date = 1; date <= daysInMonth; date++) {
    const dow = new Date(year, month - 1, date).getDay();
    const types: CollectionType[] = [];

    if (schedule.burnable.includes(dow)) types.push('burnable');
    if (recyclableDates.has(date)) types.push('recyclable');
    if (paperDates.has(date)) types.push('paper');
    if (date === nonBurnableDate) types.push('nonBurnable');
    if (date === hazardousDate) types.push('hazardous');

    if (types.length > 0) entries.push({ date, dayOfWeek: dow, types });
  }

  return { year, month, entries };
}

export function generateYearCalendar(year: number, scheduleType: 'A' | 'B' | 'C'): MonthlyCalendar[] {
  return Array.from({ length: 12 }, (_, i) => generateMonthCalendar(year, i + 1, scheduleType));
}

export const collectionTypeLabels: Record<CollectionType, string> = {
  burnable: '燃えるごみ',
  recyclable: '缶・びん・ペット',
  paper: '古紙・古布',
  nonBurnable: '燃えないごみ',
  hazardous: '有害ごみ',
};

export const collectionTypeColors: Record<CollectionType, { bg: string; text: string; border: string }> = {
  burnable: { bg: '#fef2f2', text: '#dc2626', border: '#fca5a5' },
  recyclable: { bg: '#f0fdf4', text: '#16a34a', border: '#86efac' },
  paper: { bg: '#fefce8', text: '#ca8a04', border: '#fde047' },
  nonBurnable: { bg: '#fff7ed', text: '#ea580c', border: '#fdba74' },
  hazardous: { bg: '#f5f3ff', text: '#7c3aed', border: '#c4b5fd' },
};
