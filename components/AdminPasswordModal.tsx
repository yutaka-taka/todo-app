'use client';
import { useState, useRef } from 'react';

interface Props {
  onSuccess: () => void;
  onClose: () => void;
}

const ADMIN_PASSWORD = '123454321';

export default function AdminPasswordModal({ onSuccess, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    if (password === ADMIN_PASSWORD) {
      setError(false);
      onSuccess();
    } else {
      setError(true);
      setShake(true);
      setPassword('');
      setTimeout(() => setShake(false), 600);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-800">⚙️ 管理画面</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-8 flex flex-col gap-4">
          <p className="text-sm text-gray-600 text-center">管理画面を開くにはパスワードを入力してください</p>
          <div className={`transition-transform ${shake ? 'animate-bounce' : ''}`}>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(false); }}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="パスワード"
              className={`w-full px-4 py-3 border rounded-xl text-center text-lg tracking-widest focus:outline-none focus:ring-2 ${
                error ? 'border-red-400 focus:ring-red-200 bg-red-50' : 'border-gray-200 focus:ring-blue-200'
              }`}
              autoFocus
            />
          </div>
          {error && (
            <p className="text-sm text-red-500 text-center font-medium">パスワードが違います</p>
          )}
          <button onClick={handleSubmit} className="btn-primary w-full py-3">
            確認
          </button>
        </div>
      </div>
    </div>
  );
}
