'use client';
import { GarbageItem } from '@/types';

const categoryBadgeColors: Record<string, string> = {
  '燃えるごみ': 'bg-red-100 text-red-700 border-red-200',
  '燃えないごみ': 'bg-orange-100 text-orange-700 border-orange-200',
  '資源ごみ（缶・びん・ペットボトル）': 'bg-green-100 text-green-700 border-green-200',
  '資源ごみ（古紙・古布）': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  '粗大ごみ': 'bg-purple-100 text-purple-700 border-purple-200',
  '有害ごみ': 'bg-indigo-100 text-indigo-700 border-indigo-200',
  '拠点回収': 'bg-cyan-100 text-cyan-700 border-cyan-200',
};

interface Props {
  item: GarbageItem;
  onClose: () => void;
}

export default function DetailModal({ item, onClose }: Props) {
  const badgeClass = categoryBadgeColors[item.category] ?? 'bg-gray-100 text-gray-700 border-gray-200';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div className="px-5 pb-2 pt-1 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">{item.name}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg transition-colors"
            aria-label="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          <span className={`inline-block text-sm font-medium px-3 py-1 rounded-full border ${badgeClass}`}>
            {item.category}
          </span>

          {item.details ? (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-2">詳細情報</p>
              <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">{item.details}</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-4">詳細情報はありません</p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary w-full">
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
