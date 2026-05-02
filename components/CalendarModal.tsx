'use client';
import { useEffect, useRef, useState } from 'react';
import { Region, CollectionType, DayEntry, MonthlyCalendar } from '@/types';
import { collectionTypeLabels, collectionTypeColors } from '@/lib/calendarData';

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

interface Props {
  region: Region;
  onClose: () => void;
}

export default function CalendarModal({ region, onClose }: Props) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const [calendars, setCalendars] = useState<MonthlyCalendar[]>([]);
  const [loading, setLoading] = useState(true);
  const [noData, setNoData] = useState(false);
  const [selectedDate, setSelectedDate] = useState<{ year: number; month: number; date: number; types: CollectionType[] } | null>(null);

  const monthRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/db/calendars?region=${encodeURIComponent(region.commonName)}&year=${currentYear}`);
        const data = await res.json();
        const cals: MonthlyCalendar[] = (data.calendars ?? []).map((c: { year: number; month: number; entries: DayEntry[] }) => ({
          year: c.year,
          month: c.month,
          entries: c.entries,
        }));

        if (cals.length === 0) {
          setNoData(true);
        } else {
          // 1月〜12月の順に並べ、DBにない月は空カレンダーで補完
          const calMap = new Map(cals.map(c => [`${c.year}-${c.month}`, c]));
          const full: MonthlyCalendar[] = [];
          for (let m = 1; m <= 12; m++) {
            const key = `${currentYear}-${m}`;
            full.push(calMap.get(key) ?? { year: currentYear, month: m, entries: [] });
          }
          setCalendars(full);
        }
      } catch {
        setNoData(true);
      } finally {
        setLoading(false);
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading && calendars.length > 0) {
      const el = monthRefs.current[currentMonth - 1];
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-800">📅 ごみ収集カレンダー</h2>
            <p className="text-xs text-gray-500">{region.commonName} — {currentYear}年</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg" aria-label="閉じる">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Legend */}
        <div className="px-5 py-2 flex flex-wrap gap-2 border-b border-gray-100 flex-shrink-0">
          {(Object.entries(collectionTypeLabels) as [CollectionType, string][]).map(([type, label]) => {
            const c = collectionTypeColors[type];
            return (
              <span key={type} className="text-xs px-2 py-0.5 rounded-full border font-medium"
                style={{ backgroundColor: c.bg, color: c.text, borderColor: c.border }}>
                {label}
              </span>
            );
          })}
        </div>

        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">カレンダーデータを読み込み中...</p>
            </div>
          )}

          {!loading && noData && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-4">
              <span className="text-4xl">📋</span>
              <p className="text-sm font-semibold text-gray-700">カレンダーデータがありません</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                管理画面の「ごみ年間収集予定表」で<br />
                URLを設定し「情報更新」を押してください。
              </p>
            </div>
          )}

          {!loading && !noData && calendars.map((cal, idx) => {
            const isCurrentMonth = cal.month === currentMonth && cal.year === currentYear;
            const firstDow = new Date(cal.year, cal.month - 1, 1).getDay();
            const daysInMonth = new Date(cal.year, cal.month, 0).getDate();

            const entryMap = new Map<number, CollectionType[]>();
            cal.entries.forEach((e: DayEntry) => entryMap.set(e.date, e.types));

            return (
              <div
                key={`${cal.year}-${cal.month}`}
                ref={el => { monthRefs.current[idx] = el; }}
                className={`rounded-2xl border ${isCurrentMonth ? 'border-blue-400 shadow-md' : 'border-gray-100'} bg-white overflow-hidden`}
              >
                <div className={`px-4 py-2 flex items-center justify-between ${isCurrentMonth ? 'bg-blue-500' : 'bg-gray-50'}`}>
                  <span className={`font-bold text-sm ${isCurrentMonth ? 'text-white' : 'text-gray-700'}`}>
                    {cal.year}年 {cal.month}月
                  </span>
                  {isCurrentMonth && (
                    <span className="text-xs bg-white text-blue-600 font-bold px-2 py-0.5 rounded-full">今月</span>
                  )}
                </div>

                <div className="p-2">
                  <div className="grid grid-cols-7 mb-1">
                    {DOW_LABELS.map((d, i) => (
                      <div key={d} className={`text-center text-xs font-semibold py-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}`}>
                        {d}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-7 gap-y-1">
                    {Array.from({ length: firstDow }).map((_, i) => (
                      <div key={`empty-${i}`} />
                    ))}
                    {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(date => {
                      const types = entryMap.get(date) ?? [];
                      const dow = new Date(cal.year, cal.month - 1, date).getDay();
                      const isToday = isCurrentMonth && date === now.getDate();
                      const isSelected = selectedDate?.year === cal.year && selectedDate?.month === cal.month && selectedDate?.date === date;

                      return (
                        <div
                          key={date}
                          className={`flex flex-col items-center py-0.5 ${isCurrentMonth ? 'cursor-pointer active:opacity-60' : ''}`}
                          onClick={() => {
                            if (!isCurrentMonth) return;
                            setSelectedDate(s => (s?.date === date && s?.month === cal.month) ? null : { year: cal.year, month: cal.month, date, types });
                          }}
                        >
                          <span className={`text-xs w-6 h-6 flex items-center justify-center rounded-full font-medium transition-colors
                            ${isSelected ? 'bg-amber-400 text-white ring-2 ring-amber-300' :
                              isToday ? 'bg-blue-500 text-white' :
                              dow === 0 ? 'text-red-400' :
                              dow === 6 ? 'text-blue-400' : 'text-gray-700'}`}>
                            {date}
                          </span>
                          {types.length > 0 && (
                            <div className="flex flex-wrap justify-center gap-px mt-0.5">
                              {types.map(t => (
                                <span key={t} className="w-2 h-2 rounded-full" style={{ backgroundColor: collectionTypeColors[t].text }} title={collectionTypeLabels[t]} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {selectedDate && (
          <div className="px-4 pb-2 flex-shrink-0">
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 relative">
              <button
                onClick={() => setSelectedDate(null)}
                className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded-full"
                aria-label="閉じる"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <p className="text-xs font-bold text-amber-800 mb-1.5 pr-5">
                {selectedDate.month}月{selectedDate.date}日 のごみ収集
              </p>
              {selectedDate.types.length === 0 ? (
                <p className="text-xs text-gray-500">この日の収集はありません</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {selectedDate.types.map(t => (
                    <span
                      key={t}
                      className="text-xs px-2 py-0.5 rounded-full border font-medium"
                      style={{ backgroundColor: collectionTypeColors[t].bg, color: collectionTypeColors[t].text, borderColor: collectionTypeColors[t].border }}
                    >
                      {collectionTypeLabels[t]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="px-5 py-4 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="btn-secondary w-full">閉じる</button>
        </div>
      </div>
    </div>
  );
}
