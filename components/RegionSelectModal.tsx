'use client';
import { useState } from 'react';
import { Region } from '@/types';
import { regions } from '@/lib/regionData';

interface Props {
  currentRegion?: Region | null;
  canClose: boolean;
  onSelect: (region: Region) => void;
  onClose?: () => void;
}

export default function RegionSelectModal({ currentRegion, canClose, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Region | null>(currentRegion ?? null);

  const filtered = regions.filter(r =>
    r.adminName.includes(search) || r.commonName.includes(search)
  );

  const handleConfirm = () => {
    if (selected) onSelect(selected);
  };

  return (
    <div className="modal-overlay" onClick={canClose ? onClose : undefined}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-800">📍 地域を選択してください</h2>
            <p className="text-xs text-gray-500">お住まいの地域を選んでください</p>
          </div>
          {canClose && onClose && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="px-5 py-3 flex-shrink-0">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 1116.65 16.65z" />
            </svg>
            <input
              type="text"
              placeholder="地域名で検索..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-xl text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-5 pb-2 space-y-1.5">
          {filtered.map(r => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className={`w-full text-left px-4 py-2.5 rounded-xl border transition-all ${
                selected?.id === r.id
                  ? 'border-blue-400 bg-blue-50 shadow-sm'
                  : 'border-gray-100 bg-white hover:border-gray-300'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-gray-800">{r.adminName}</p>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full flex-shrink-0">
                  {r.commonName}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">収集グループ {r.calendarGroup}</p>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-8">該当する地域が見つかりません</p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex-shrink-0 space-y-2">
          <button
            onClick={handleConfirm}
            disabled={!selected}
            className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors ${
              selected
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {selected ? `「${selected.adminName}（${selected.commonName}）」を選択する` : '地域を選んでください'}
          </button>
        </div>
      </div>
    </div>
  );
}
