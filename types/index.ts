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
  category: GarbageCategory;
  categoryColor: string;
  summary: string;
  details: string;
  disposalMethod: string;
  notes?: string;
}

export interface Region {
  id: string;
  adminName: string;
  commonName: string;
  scheduleType: 'A' | 'B' | 'C';
}

export type CollectionType =
  | 'burnable'
  | 'recyclable'
  | 'paper'
  | 'nonBurnable'
  | 'hazardous';

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
