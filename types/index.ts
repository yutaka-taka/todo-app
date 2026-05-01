export type GarbageCategory =
  | '燃えるごみ'
  | '燃えないごみ'
  | '資源ごみ（缶・びん・ペットボトル）'
  | '資源ごみ（古紙・古布）'
  | '粗大ごみ'
  | '有害ごみ'
  | '拠点回収';

export interface GarbageItem {
  id: string;
  name: string;
  keywords: string[];
  category: GarbageCategory | string;
  categoryColor: string;
  details: string;
}

export interface Region {
  id: string;
  adminName: string;     // 行政連絡区名
  commonName: string;    // 地域の通称名
  calendarGroup: number; // 年間収集予定表グループ番号（1-42）
  scheduleType: 'A' | 'B' | 'C' | 'D';
}

export type CollectionType =
  | 'burnable'
  | 'plastic'
  | 'branches'
  | 'cans'
  | 'pet'
  | 'bottlesBatteries'
  | 'paper'
  | 'nonBurnable';

export interface DayEntry {
  date: number;
  dayOfWeek: number;
  types: CollectionType[];
}

export interface MonthlyCalendar {
  year: number;
  month: number;
  entries: DayEntry[];
}
