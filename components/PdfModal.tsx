'use client';

interface Props {
  url: string;
  title?: string;
  onClose: () => void;
}

export default function PdfModal({ url, title = '年間収集予定表', onClose }: Props) {
  // Google Docs Viewer でモバイルでも表示できるようにする
  const viewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex flex-col">
      {/* Header */}
      <div className="bg-[#1a1a2e] text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">📄</span>
          <span className="text-sm font-bold truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-lg transition-colors"
          >
            別タブで開く
          </a>
          <button
            onClick={onClose}
            className="w-8 h-8 bg-white/15 hover:bg-white/25 rounded-full flex items-center justify-center transition-colors"
            aria-label="閉じる"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* PDF Viewer */}
      <div className="flex-1 bg-gray-200 relative">
        <iframe
          src={viewerUrl}
          className="w-full h-full border-0"
          title={title}
          allow="fullscreen"
        />
        {/* フォールバック：読み込めない場合 */}
        <noscript>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gray-100">
            <p className="text-sm text-gray-600">PDFを表示できません</p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary px-6 py-2"
            >
              PDFを開く
            </a>
          </div>
        </noscript>
      </div>

      {/* Footer */}
      <div className="bg-white px-4 py-3 border-t border-gray-100 flex-shrink-0">
        <button onClick={onClose} className="btn-secondary w-full">
          閉じる
        </button>
      </div>
    </div>
  );
}
