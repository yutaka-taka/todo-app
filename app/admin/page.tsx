'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_INFO_URL = 'https://www.city.nagano.nagano.jp/n121500/contents/p006210.html';
const DEFAULT_PDF_URL = 'https://www.city.nagano.nagano.jp/documents/238/r8hozonban.pdf';

export default function AdminPage() {
  const router = useRouter();

  const [infoUrl, setInfoUrl] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    setInfoUrl(localStorage.getItem('infoUrl') || DEFAULT_INFO_URL);
    setPdfUrl(localStorage.getItem('pdfUrl') || DEFAULT_PDF_URL);
    setLastUpdated(localStorage.getItem('lastUpdated'));
  }, []);

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

      if (data.items && data.items.length > 0) {
        localStorage.setItem('fetchedGarbageData', JSON.stringify(data.items));
      }
      const ts = new Date().toLocaleString('ja-JP');
      localStorage.setItem('lastUpdated', ts);
      setLastUpdated(ts);
      setUpdateStatus('success');
      setUpdateMessage(`${data.items?.length ?? 0}件の情報を更新しました`);
    } catch (e) {
      setUpdateStatus('error');
      setUpdateMessage(e instanceof Error ? e.message : '更新に失敗しました');
    }
  };

  const handlePdfSave = () => {
    localStorage.setItem('pdfUrl', pdfUrl.trim());
    setUpdateStatus('success');
    setUpdateMessage('PDFのURLを保存しました');
    setTimeout(() => setUpdateStatus('idle'), 2000);
  };

  const handleOpenPdf = () => {
    const url = pdfUrl.trim() || DEFAULT_PDF_URL;
    window.open(url, '_blank', 'noopener,noreferrer');
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

        {/* ごみの出し方PDF URL */}
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
              <span>📄</span> ごみの出し方（PDF URL）
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">年間収集予定表・ごみの出し方PDFのURL</p>
          </div>
          <textarea
            value={pdfUrl}
            onChange={e => setPdfUrl(e.target.value)}
            rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50 resize-none"
            placeholder={DEFAULT_PDF_URL}
          />
          <div className="flex gap-2">
            <button
              onClick={handlePdfSave}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm bg-green-500 hover:bg-green-600 text-white transition-colors"
            >
              💾 URLを保存
            </button>
            <button
              onClick={handleOpenPdf}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
            >
              📖 ごみの出し方
            </button>
          </div>
        </div>

        {/* 年間収集予定表URL（旧URL欄・互換のため残す） */}
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
              <span>📅</span> 年間収集予定表URL
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">「年間収集予定表」ボタンで開くページのURL</p>
          </div>
          <ScheduleUrlEditor />
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

function ScheduleUrlEditor() {
  const DEFAULT = 'https://www.city.nagano.nagano.jp/n121500/contents/p006210.html';
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setUrl(localStorage.getItem('scheduleUrl') || DEFAULT);
  }, []);

  const save = () => {
    localStorage.setItem('scheduleUrl', url.trim() || DEFAULT);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <textarea
        value={url}
        onChange={e => setUrl(e.target.value)}
        rows={3}
        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50 resize-none"
        placeholder={DEFAULT}
      />
      <button
        onClick={save}
        className={`w-full py-2.5 rounded-xl font-semibold text-sm transition-colors ${
          saved ? 'bg-green-500 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
        }`}
      >
        {saved ? '✅ 保存しました' : '💾 URLを保存'}
      </button>
    </>
  );
}
