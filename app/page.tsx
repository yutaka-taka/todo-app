'use client';
import { useState, useEffect, useRef } from 'react';
import { Region, GarbageItem } from '@/types';
import { searchGarbage } from '@/lib/garbageData';
import DetailModal from '@/components/DetailModal';
import CalendarModal from '@/components/CalendarModal';
import RegionSelectModal from '@/components/RegionSelectModal';
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

export default function Home() {
  const router = useRouter();
  const [region, setRegion] = useState<Region | null>(null);
  const [regionLoaded, setRegionLoaded] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GarbageItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedItem, setSelectedItem] = useState<GarbageItem | null>(null);

  const [showDetail, setShowDetail] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showRegion, setShowRegion] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showAdminPw, setShowAdminPw] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const [pdfUrl, setPdfUrl] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('selectedRegion');
      if (saved) setRegion(JSON.parse(saved));
      else setShowRegion(true);
    } catch {
      setShowRegion(true);
    }
    setRegionLoaded(true);
  }, []);

  const handleSearch = () => {
    if (!query.trim()) return;
    const res = searchGarbage(query.trim());
    setResults(res);
    setHasSearched(true);
  };

  const handleRegionSelect = (r: Region) => {
    setRegion(r);
    localStorage.setItem('selectedRegion', JSON.stringify(r));
    setShowRegion(false);
  };

  const handleCameraIdentified = (name: string) => {
    setQuery(name);
    const res = searchGarbage(name);
    setResults(res);
    setHasSearched(true);
    setShowCamera(false);
  };

  const handleOpenDetail = (item: GarbageItem) => {
    setSelectedItem(item);
    setShowDetail(true);
  };

  const handleOpenPDF = () => {
    const url = localStorage.getItem('pdfUrl') ||
      'https://www.city.nagano.nagano.jp/documents/238/r8hozonban.pdf';
    setPdfUrl(url);
    setShowPdf(true);
  };

  if (!regionLoaded) return null;

  return (
    <>
      {/* Header */}
      <div className="bg-[#1a1a2e] text-white px-5 pt-12 pb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🗑️</span>
            <div>
              <h1 className="text-lg font-bold tracking-wide">ごみ分別アプリ</h1>
              <p className="text-xs text-slate-400">長野市</p>
            </div>
          </div>
          {region && (
            <button
              onClick={() => setShowRegion(true)}
              className="flex items-center gap-1 bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full text-xs transition-colors"
            >
              <span>📍</span>
              <span className="max-w-[80px] truncate">{region.commonName}</span>
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-5 space-y-4">
        {/* Search section */}
        <div className="card space-y-3">
          <div className="flex items-center gap-1.5 mb-1">
            <h2 className="text-sm font-bold text-gray-700">分別調査</h2>
          </div>

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
              onClick={handleSearch}
              className="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white w-11 h-11 rounded-xl flex items-center justify-center transition-colors flex-shrink-0"
              aria-label="検索"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 1116.65 16.65z" />
              </svg>
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

          {/* Results */}
          {hasSearched && (
            <div className="border-t border-gray-100 pt-3 space-y-2">
              {results.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-2">「{query}」に該当するごみが見つかりませんでした</p>
              ) : (
                results.map(item => (
                  <div key={item.id} className="bg-gray-50 rounded-xl p-3 flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-800">{item.name}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryBadgeColors[item.category] ?? 'bg-gray-100 text-gray-600'}`}>
                          {item.category}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.summary}</p>
                    </div>
                    <button
                      onClick={() => handleOpenDetail(item)}
                      className="flex-shrink-0 bg-blue-500 hover:bg-blue-600 text-white w-8 h-8 rounded-lg transition-colors flex items-center justify-center"
                      aria-label="詳細"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 1116.65 16.65z" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Action buttons grid */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleOpenPDF}
            className="card flex flex-col items-center gap-2 py-5 hover:shadow-md active:scale-95 transition-all"
          >
            <span className="text-3xl">📄</span>
            <span className="text-xs font-semibold text-gray-700 text-center leading-tight">年間収集<br/>予定表</span>
          </button>

          <button
            onClick={() => region && setShowCalendar(true)}
            disabled={!region}
            className={`card flex flex-col items-center gap-2 py-5 transition-all ${
              region ? 'hover:shadow-md active:scale-95' : 'opacity-50'
            }`}
          >
            <span className="text-3xl">📅</span>
            <span className="text-xs font-semibold text-gray-700 text-center leading-tight">収集<br/>カレンダー</span>
          </button>

          <button
            onClick={() => setShowRegion(true)}
            className="card flex flex-col items-center gap-2 py-5 hover:shadow-md active:scale-95 transition-all"
          >
            <span className="text-3xl">📍</span>
            <span className="text-xs font-semibold text-gray-700 text-center leading-tight">地域<br/>選択</span>
          </button>

          <button
            onClick={() => setShowAdminPw(true)}
            className="card flex flex-col items-center gap-2 py-5 hover:shadow-md active:scale-95 transition-all"
          >
            <span className="text-3xl">⚙️</span>
            <span className="text-xs font-semibold text-gray-700 text-center leading-tight">管理</span>
          </button>
        </div>

        {/* Footer info */}
        {region && (
          <div className="text-center">
            <p className="text-xs text-gray-400">選択中の地域: {region.adminName}</p>
          </div>
        )}
      </div>

      {/* Modals */}
      {showDetail && selectedItem && (
        <DetailModal item={selectedItem} onClose={() => setShowDetail(false)} />
      )}
      {showCalendar && region && (
        <CalendarModal region={region} onClose={() => setShowCalendar(false)} />
      )}
      {showRegion && (
        <RegionSelectModal
          currentRegion={region}
          canClose={!!region}
          onSelect={handleRegionSelect}
          onClose={() => setShowRegion(false)}
        />
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
        <PdfModal url={pdfUrl} title="年間収集予定表" onClose={() => setShowPdf(false)} />
      )}
    </>
  );
}
