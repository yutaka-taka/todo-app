'use client';
import { useState, useEffect, useRef } from 'react';
import { GarbageItem, Region } from '@/types';
import { searchGarbage } from '@/lib/garbageData';
import DetailModal from '@/components/DetailModal';
import CalendarModal from '@/components/CalendarModal';
import CameraModal from '@/components/CameraModal';
import AdminPasswordModal from '@/components/AdminPasswordModal';
import PdfModal from '@/components/PdfModal';
import { useRouter } from 'next/navigation';

const categoryBadgeColors: Record<string, string> = {
  '燃えるごみ': 'bg-red-100 text-red-700',
  '燃えないごみ': 'bg-orange-100 text-orange-700',
  '資源ごみ（缶・びん・ペットボトル）': 'bg-green-100 text-green-700',
  '資源ごみ（古紙・古布）': 'bg-yellow-100 text-yellow-700',
  '粗大ごみ': 'bg-purple-100 text-purple-700',
  '有害ごみ': 'bg-indigo-100 text-indigo-700',
  '拠点回収': 'bg-cyan-100 text-cyan-700',
};

// 浅川地区固定
const ASAKAWA_REGION: Region = {
  id: 'g14-0',
  adminName: '浅川東条',
  commonName: '浅川',
  calendarGroup: 14,
  scheduleType: 'A',
};

const DEFAULT_PDF_URL = 'https://www.city.nagano.nagano.jp/documents/238/r8hozonban.pdf';
const DEFAULT_ANNUAL_URL = 'https://www.city.nagano.nagano.jp/documents/22303/r8nittei12.pdf';

// Gemini 2.5 Flash 無料枠レート制限
const GEMINI_RPM = 10;
const GEMINI_RPD = 500;
const CAMERA_USAGE_KEY = 'cameraUsageTimestamps';

function getRemainingUsage(): { perMinute: number; perDay: number } {
  try {
    const raw = localStorage.getItem(CAMERA_USAGE_KEY);
    const timestamps: number[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const lastMinute = timestamps.filter(t => t > now - 60000).length;
    const lastDay = timestamps.filter(t => t > now - 86400000).length;
    return {
      perMinute: Math.max(0, GEMINI_RPM - lastMinute),
      perDay: Math.max(0, GEMINI_RPD - lastDay),
    };
  } catch {
    return { perMinute: GEMINI_RPM, perDay: GEMINI_RPD };
  }
}

function recordCameraUsage() {
  try {
    const raw = localStorage.getItem(CAMERA_USAGE_KEY);
    const timestamps: number[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const cleaned = timestamps.filter(t => t > now - 86400000);
    cleaned.push(now);
    localStorage.setItem(CAMERA_USAGE_KEY, JSON.stringify(cleaned));
  } catch { /* ignore */ }
}

function dbRowToGarbageItem(row: Record<string, unknown>): GarbageItem {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    category: (row.category as GarbageItem['category']) ?? '燃えるごみ',
    categoryColor: '#64748b',
    details: String(row.details ?? ''),
  };
}

export default function Home() {
  const router = useRouter();
  const region: Region = ASAKAWA_REGION;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GarbageItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedItem, setSelectedItem] = useState<GarbageItem | null>(null);

  const [showDetail, setShowDetail] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showAdminPw, setShowAdminPw] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfTitle, setPdfTitle] = useState('');
  const [showSizeLimit, setShowSizeLimit] = useState(false);
  const [cameraUsage, setCameraUsage] = useState({ perMinute: GEMINI_RPM, perDay: GEMINI_RPD });

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCameraUsage(getRemainingUsage());
    // 1分ごとに残回数を更新
    const timer = setInterval(() => setCameraUsage(getRemainingUsage()), 60000);
    return () => clearInterval(timer);
  }, []);

  const handleSearch = async (q?: string) => {
    const searchQuery = (q ?? query).trim();
    if (!searchQuery) return;
    setSearching(true);
    setHasSearched(true);

    const localResults = searchGarbage(searchQuery);

    try {
      const res = await fetch(`/api/db/garbage?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      const dbItems: GarbageItem[] = (data.items ?? []).map(dbRowToGarbageItem);

      const localNames = new Set(localResults.map(i => i.name));
      const merged = [
        ...localResults,
        ...dbItems.filter(i => !localNames.has(i.name)),
      ];

      const exactMatch = merged.find(i => i.name === searchQuery);
      setResults(exactMatch ? [exactMatch] : merged.slice(0, 3));
    } catch {
      setResults(localResults);
    }
    setSearching(false);
  };

  const handleCameraIdentified = async (name: string) => {
    recordCameraUsage();
    setCameraUsage(getRemainingUsage());
    const parenMatch = name.match(/[（(]([^）)]+)[）)]/);
    const candidate = parenMatch ? parenMatch[1] : name;
    const materials = ['プラスチック', 'ペットボトル', 'アルミ', 'スチール', '金属', 'ガラス', 'びん',
      '陶磁器', 'ゴム', '革', '木', '紙', '布', '段ボール', '発泡スチロール', '缶', 'プラ'];
    const searchTerm = materials.find(m => candidate.includes(m)) ?? candidate;
    setQuery(searchTerm);
    setShowCamera(false);
    await handleSearch(searchTerm);
  };

  const handleOpenDetail = (item: GarbageItem) => {
    setSelectedItem(item);
    setShowDetail(true);
  };

  const handleOpenAnnualPdf = () => {
    const url = localStorage.getItem('annualUrl') || DEFAULT_ANNUAL_URL;
    setPdfUrl(url);
    setPdfTitle('年間収集予定表（浅川）');
    setShowPdf(true);
  };

  const handleOpenGomiPdf = () => {
    const url = localStorage.getItem('pdfUrl') || DEFAULT_PDF_URL;
    setPdfUrl(url);
    setPdfTitle('ゴミの出し方');
    setShowPdf(true);
  };

  return (
    <>
      {/* Header */}
      <div className="bg-[#1a1a2e] text-white px-5 pt-12 pb-5">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🗑️</span>
          <div>
            <h1 className="text-lg font-bold tracking-wide">ごみ分別アプリ</h1>
            <p className="text-xs text-slate-400">長野市 浅川地区</p>
          </div>
        </div>
      </div>

      <div className="px-4 py-5 space-y-4">
        {/* Search section */}
        <div className="card space-y-3">
          <h2 className="text-sm font-bold text-gray-700">分別調査</h2>

          {/* Search row */}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="ごみの名前を入力"
              className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50"
            />
            <button
              onClick={() => handleSearch()}
              disabled={searching}
              className="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white w-11 h-11 rounded-xl flex items-center justify-center transition-colors flex-shrink-0"
              aria-label="検索"
            >
              {searching ? (
                <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="7" strokeWidth={2} />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35" />
                </svg>
              )}
            </button>
          </div>

          {/* Camera button */}
          <button
            onClick={() => setShowCamera(true)}
            className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-gray-200 hover:border-green-400 hover:bg-green-50 py-2.5 rounded-xl text-sm text-gray-500 hover:text-green-600 transition-colors"
          >
            <span className="text-base">📷</span>
            <span>カメラで自動識別</span>
          </button>

          {/* Camera usage display */}
          <p className="text-xs text-gray-400 text-center">
            １分間の残使用回数：{cameraUsage.perMinute}回　本日の残使用回数：{cameraUsage.perDay}回
          </p>

          {/* Results */}
          {hasSearched && (
            <div className="border-t border-gray-100 pt-3 space-y-2">
              {results.length === 0 && !searching ? (
                <p className="text-sm text-gray-400 text-center py-2">「{query}」に該当するごみが見つかりませんでした</p>
              ) : (
                results.map(item => (
                  <div key={item.id} className="bg-gray-50 rounded-xl p-3 flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-800">{item.name}</span>
                        {item.category && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryBadgeColors[item.category] ?? 'bg-gray-100 text-gray-600'}`}>
                            {item.category}
                          </span>
                        )}
                      </div>
                      {item.details && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.details}</p>}
                    </div>
                    <button
                      onClick={() => handleOpenDetail(item)}
                      className="flex-shrink-0 bg-blue-500 hover:bg-blue-600 text-white px-3 h-8 rounded-lg transition-colors text-xs font-semibold"
                    >
                      詳細
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handleOpenAnnualPdf}
              className="card flex flex-col items-center gap-2 py-5 hover:shadow-md active:scale-95 transition-all"
            >
              <span className="text-3xl">📄</span>
              <span className="text-xs font-semibold text-gray-700 text-center leading-tight">年間収集<br/>予定表</span>
            </button>

            <button
              onClick={() => setShowCalendar(true)}
              className="card flex flex-col items-center gap-2 py-5 hover:shadow-md active:scale-95 transition-all"
            >
              <span className="text-3xl">📅</span>
              <span className="text-xs font-semibold text-gray-700 text-center leading-tight">収集<br/>カレンダー</span>
            </button>
          </div>

          {/* 大きさ制限ボタン */}
          <button
            onClick={() => setShowSizeLimit(true)}
            className="w-full card flex items-center justify-center gap-2 py-3 hover:shadow-md active:scale-95 transition-all"
          >
            <span className="text-lg">📏</span>
            <span className="text-sm font-semibold text-gray-700">大きさ制限</span>
          </button>

          {/* ゴミの出し方(pdf)ボタン */}
          <button
            onClick={handleOpenGomiPdf}
            className="w-full card flex items-center justify-center gap-2 py-3 hover:shadow-md active:scale-95 transition-all"
          >
            <span className="text-lg">📋</span>
            <span className="text-sm font-semibold text-gray-700">ゴミの出し方(pdf)</span>
          </button>

          {/* 管理ボタン（横長） */}
          <button
            onClick={() => setShowAdminPw(true)}
            className="w-full card flex items-center justify-center gap-2 py-3 hover:shadow-md active:scale-95 transition-all"
          >
            <span className="text-lg">⚙️</span>
            <span className="text-sm font-semibold text-gray-700">管理</span>
          </button>
        </div>

        <div className="text-center">
          <p className="text-xs text-gray-400">選択中: {region.commonName}</p>
        </div>
      </div>

      {/* Modals */}
      {showDetail && selectedItem && (
        <DetailModal item={selectedItem} onClose={() => setShowDetail(false)} />
      )}
      {showCalendar && (
        <CalendarModal region={region} onClose={() => setShowCalendar(false)} />
      )}
      {showCamera && (
        <CameraModal
          onIdentified={handleCameraIdentified}
          onClose={() => setShowCamera(false)}
        />
      )}
      {showAdminPw && (
        <AdminPasswordModal
          onSuccess={() => { setShowAdminPw(false); router.push('/admin'); }}
          onClose={() => setShowAdminPw(false)}
        />
      )}
      {showPdf && pdfUrl && (
        <PdfModal url={pdfUrl} title={pdfTitle} onClose={() => setShowPdf(false)} />
      )}
      {showSizeLimit && (
        <div className="modal-overlay" onClick={() => setShowSizeLimit(false)}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <div className="modal-handle" />
            <div className="px-5 pb-2 pt-1 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-800">📏 大きさ制限</h2>
              <button onClick={() => setShowSizeLimit(false)} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg" aria-label="閉じる">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {[
                {
                  category: '可燃ごみ',
                  color: 'bg-red-50 border-red-200',
                  labelColor: 'bg-red-100 text-red-700',
                  rows: [
                    { label: '集積所', value: '1m×50cm×50cm以内' },
                    { label: '直接持ち込み', value: '2m50cm×1m50cm×1m以内（木材は厚さ20cm未満かつ長さ2m50cm以内）' },
                    { label: '処理施設', value: 'ながの環境エネルギーセンター' },
                  ],
                },
                {
                  category: '不燃ごみ',
                  color: 'bg-orange-50 border-orange-200',
                  labelColor: 'bg-orange-100 text-orange-700',
                  rows: [
                    { label: '集積所', value: '1m×50cm×50cm以内（※1）' },
                    { label: '直接持ち込み', value: '1m80cm×1m×50cm以内（三脚・サッシ等の単一金属は3mまで）' },
                    { label: '処理施設', value: '資源再生センター（※2）' },
                  ],
                },
                {
                  category: '本体から充電式電池が外れない小型家電',
                  color: 'bg-blue-50 border-blue-200',
                  labelColor: 'bg-blue-100 text-blue-700',
                  rows: [
                    { label: '集積所', value: '30cm 未満まで' },
                    { label: '直接持ち込み', value: '集積所に出せるサイズのほか、30cm以上のものも可' },
                  ],
                },
              ].map(({ category, color, labelColor, rows }) => (
                <div key={category} className={`rounded-xl border p-3 space-y-2 ${color}`}>
                  <p className={`text-xs font-bold px-2 py-0.5 rounded-full inline-block ${labelColor}`}>{category}</p>
                  {rows.map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs font-semibold text-gray-500">{label}</p>
                      <p className="text-sm text-gray-800 leading-snug">{value}</p>
                    </div>
                  ))}
                </div>
              ))}
              <div className="bg-gray-50 rounded-xl p-3 space-y-1">
                <p className="text-xs font-bold text-gray-600">注意事項</p>
                <p className="text-xs text-gray-600 leading-relaxed">※1 自転車（電動自転車を除く）・スキー板は基準を上回る大きさであっても例外的に集積所に排出可能</p>
                <p className="text-xs text-gray-600 leading-relaxed">※2 ながの環境エネルギーセンターの受付を通って持ち込む</p>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-100">
              <button onClick={() => setShowSizeLimit(false)} className="btn-secondary w-full">閉じる</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
