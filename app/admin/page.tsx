'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_INFO_URL = 'https://www.city.nagano.nagano.jp/n121500/contents/p006210.html';
const DEFAULT_PDF_URL = 'https://www.city.nagano.nagano.jp/documents/238/r8hozonban.pdf';
const DEFAULT_SEPARATION_URL = 'https://www.city.nagano.nagano.jp/gomi/menu/gomikensaku/i/index.html?utm_source=chatgpt.com';

export default function AdminPage() {
  const router = useRouter();

  const [infoUrl, setInfoUrl] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [pdfUpdateStatus, setPdfUpdateStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [pdfUpdateMessage, setPdfUpdateMessage] = useState('');
  const [pdfLastUpdated, setPdfLastUpdated] = useState<string | null>(null);

  const [separationUrl, setSeparationUrl] = useState('');
  const [separationStatus, setSeparationStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [separationMessage, setSeparationMessage] = useState('');
  const [separationLastUpdated, setSeparationLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    setInfoUrl(localStorage.getItem('infoUrl') || DEFAULT_INFO_URL);
    setPdfUrl(localStorage.getItem('pdfUrl') || DEFAULT_PDF_URL);
    setSeparationUrl(localStorage.getItem('separationUrl') || DEFAULT_SEPARATION_URL);
    setLastUpdated(localStorage.getItem('lastUpdated'));
    setPdfLastUpdated(localStorage.getItem('pdfLastUpdated'));
    setSeparationLastUpdated(localStorage.getItem('separationLastUpdated'));
  }, []);

  // ごみの出し方URLは変更のたびに自動保存
  useEffect(() => {
    if (pdfUrl) localStorage.setItem('pdfUrl', pdfUrl);
  }, [pdfUrl]);

  const handleInfoUpdate = async () => {
    if (!infoUrl.trim()) return;
    localStorage.setItem('infoUrl', infoUrl.trim());

    setUpdateStatus('loading');
    setUpdateMessage('');

    try {
      const res = await fetch('/api/fetch-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: infoUrl.trim() }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? 'エラーが発生しました');

      // DBに保存
      if (data.items && data.items.length > 0) {
        await fetch('/api/db/garbage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: data.items, sourceUrl: infoUrl.trim() }),
        });
      }
      // 地区PDFリンクをDBに保存
      if (data.pdfs && data.pdfs.length > 0) {
        await fetch('/api/db/pdfs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfs: data.pdfs, sourceUrl: infoUrl.trim() }),
        });
        // region_schedulesにも保存
        for (const pdf of data.pdfs) {
          await fetch('/api/db/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              regionKey: pdf.regionName,
              calendarGroup: pdf.calendarGroup ?? 0,
              pdfUrl: pdf.pdfUrl,
              pdfTitle: pdf.pdfTitle,
            }),
          }).catch(() => null);
        }
      }
      const ts = new Date().toLocaleString('ja-JP');
      localStorage.setItem('lastUpdated', ts);
      setLastUpdated(ts);
      setUpdateStatus('success');
      const pdfCount = data.pdfs?.length ?? 0;
      setUpdateMessage(`${data.insertedItems ?? data.items?.length ?? 0}件のごみ情報、${pdfCount}件の地区PDFをDBに保存しました`);
    } catch (e) {
      setUpdateStatus('error');
      setUpdateMessage(e instanceof Error ? e.message : '更新に失敗しました');
    }
  };

  const handleSeparationUpdate = async () => {
    if (!separationUrl.trim()) return;
    localStorage.setItem('separationUrl', separationUrl.trim());
    setSeparationStatus('loading');
    setSeparationMessage('');

    try {
      const res = await fetch('/api/fetch-separation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: separationUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'エラーが発生しました');

      const ts = new Date().toLocaleString('ja-JP');
      localStorage.setItem('separationLastUpdated', ts);
      setSeparationLastUpdated(ts);
      setSeparationStatus('success');
      setSeparationMessage(
        `${data.insertedCount ?? 0}件をDBに保存しました（合計取得: ${data.totalItems ?? 0}件、取得かな: ${data.fetchedKana?.length ?? 0}行）`
      );
    } catch (e) {
      setSeparationStatus('error');
      setSeparationMessage(e instanceof Error ? e.message : '更新に失敗しました');
    }
  };

  const handlePdfUpdate = async () => {
    if (!pdfUrl.trim()) return;
    setPdfUpdateStatus('loading');
    setPdfUpdateMessage('');

    try {
      const res = await fetch('/api/fetch-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: pdfUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'エラーが発生しました');

      // 既存データに追記（蓄積）
      const existing = JSON.parse(localStorage.getItem('gomiNoShikataData') || '[]');
      const merged = [...existing, ...(data.items ?? [])].filter(
        (item, idx, arr) => arr.findIndex(i => i.name === item.name) === idx
      );
      localStorage.setItem('gomiNoShikataData', JSON.stringify(merged));

      const ts = new Date().toLocaleString('ja-JP');
      localStorage.setItem('pdfLastUpdated', ts);
      setPdfLastUpdated(ts);
      setPdfUpdateStatus('success');
      setPdfUpdateMessage(`${data.items?.length ?? 0}件の情報を蓄積しました（合計${merged.length}件）`);
    } catch (e) {
      setPdfUpdateStatus('error');
      setPdfUpdateMessage(e instanceof Error ? e.message : '更新に失敗しました');
    }
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="bg-[#1a1a2e] text-white px-5 pt-12 pb-5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/')}
            className="w-8 h-8 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center transition-colors"
            aria-label="戻る"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-lg font-bold">⚙️ 管理画面</h1>
            <p className="text-xs text-slate-400">データ管理・URL設定</p>
          </div>
        </div>
      </div>

      <div className="px-4 py-5 space-y-4">
        {/* Status banner */}
        {updateStatus !== 'idle' && (
          <div className={`rounded-xl px-4 py-3 text-sm font-medium flex items-center gap-2 ${
            updateStatus === 'loading' ? 'bg-blue-50 text-blue-700' :
            updateStatus === 'success' ? 'bg-green-50 text-green-700' :
            'bg-red-50 text-red-700'
          }`}>
            {updateStatus === 'loading' && (
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {updateStatus === 'success' && <span>✅</span>}
            {updateStatus === 'error' && <span>❌</span>}
            <span>{updateStatus === 'loading' ? '更新中...' : updateMessage}</span>
          </div>
        )}

        {/* 分別情報URL */}
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
              <span>🔗</span> 分別情報URL
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">ごみ分別情報を取得するWebページのURL</p>
          </div>
          <textarea
            value={infoUrl}
            onChange={e => setInfoUrl(e.target.value)}
            rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50 resize-none"
            placeholder={DEFAULT_INFO_URL}
          />
          <button
            onClick={handleInfoUpdate}
            disabled={updateStatus === 'loading'}
            className={`w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors ${
              updateStatus === 'loading'
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
            }`}
          >
            {updateStatus === 'loading' ? (
              <>
                <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                更新中...
              </>
            ) : (
              <>🔄 情報更新</>
            )}
          </button>
          {lastUpdated && (
            <p className="text-xs text-gray-400 text-center">最終更新: {lastUpdated}</p>
          )}
        </div>

        {/* 分別一覧URL */}
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
              <span>📋</span> 分別一覧URL
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">「あ」〜「わ」ボタンがあるごみ品目一覧ページのURL</p>
          </div>
          <textarea
            value={separationUrl}
            onChange={e => {
              setSeparationUrl(e.target.value);
              localStorage.setItem('separationUrl', e.target.value);
            }}
            rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-200 bg-gray-50 resize-none"
            placeholder={DEFAULT_SEPARATION_URL}
          />
          {separationStatus !== 'idle' && (
            <div className={`rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-2 ${
              separationStatus === 'loading' ? 'bg-blue-50 text-blue-700' :
              separationStatus === 'success' ? 'bg-green-50 text-green-700' :
              'bg-red-50 text-red-700'
            }`}>
              {separationStatus === 'loading' && <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
              {separationStatus === 'success' && <span>✅</span>}
              {separationStatus === 'error' && <span>❌</span>}
              <span>{separationStatus === 'loading' ? '「あ」〜「わ」を順番に取得中... しばらくお待ちください' : separationMessage}</span>
            </div>
          )}
          <button
            onClick={handleSeparationUpdate}
            disabled={separationStatus === 'loading'}
            className={`w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors ${
              separationStatus === 'loading'
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-green-500 hover:bg-green-600 text-white'
            }`}
          >
            {separationStatus === 'loading' ? (
              <>
                <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                取得中...
              </>
            ) : (
              <>🔄 情報更新</>
            )}
          </button>
          {separationLastUpdated && (
            <p className="text-xs text-gray-400 text-center">最終更新: {separationLastUpdated}</p>
          )}
        </div>

        {/* ごみの出し方URL */}
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
              <span>📄</span> ごみの出し方URL
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">URLは自動保存されます</p>
          </div>
          <textarea
            value={pdfUrl}
            onChange={e => setPdfUrl(e.target.value)}
            rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50 resize-none"
            placeholder={DEFAULT_PDF_URL}
          />
          {pdfUpdateStatus !== 'idle' && (
            <div className={`rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-2 ${
              pdfUpdateStatus === 'loading' ? 'bg-blue-50 text-blue-700' :
              pdfUpdateStatus === 'success' ? 'bg-green-50 text-green-700' :
              'bg-red-50 text-red-700'
            }`}>
              {pdfUpdateStatus === 'loading' && <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
              {pdfUpdateStatus === 'success' && <span>✅</span>}
              {pdfUpdateStatus === 'error' && <span>❌</span>}
              <span>{pdfUpdateStatus === 'loading' ? '更新中...' : pdfUpdateMessage}</span>
            </div>
          )}
          <button
            onClick={handlePdfUpdate}
            disabled={pdfUpdateStatus === 'loading'}
            className={`w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors ${
              pdfUpdateStatus === 'loading'
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
            }`}
          >
            {pdfUpdateStatus === 'loading' ? (
              <>
                <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                更新中...
              </>
            ) : (
              <>🔄 情報更新</>
            )}
          </button>
          {pdfLastUpdated && (
            <p className="text-xs text-gray-400 text-center">最終更新: {pdfLastUpdated}</p>
          )}
        </div>

        {/* Reset */}
        <div className="card">
          <h2 className="text-sm font-bold text-gray-700 mb-2">⚠️ データリセット</h2>
          <button
            onClick={() => {
              if (confirm('取得したデータをリセットしますか？初期データに戻ります。')) {
                localStorage.removeItem('fetchedGarbageData');
                localStorage.removeItem('lastUpdated');
                setLastUpdated(null);
                setUpdateStatus('success');
                setUpdateMessage('データをリセットしました');
                setTimeout(() => setUpdateStatus('idle'), 2000);
              }
            }}
            className="w-full py-2.5 rounded-xl text-sm text-red-500 border border-red-200 hover:bg-red-50 transition-colors"
          >
            取得データをリセット
          </button>
        </div>

        {/* Back button */}
        <button
          onClick={() => router.push('/')}
          className="w-full py-3 rounded-xl bg-[#1a1a2e] text-white font-semibold text-sm hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          メニューに戻る
        </button>
      </div>
    </div>
  );
}

