'use client';
import { useEffect, useRef, useState, useCallback } from 'react';

interface Props {
  onIdentified: (name: string) => void;
  onClose: () => void;
}

export default function CameraModal({ onIdentified, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [timeLeft, setTimeLeft] = useState(30);
  const [status, setStatus] = useState<'loading' | 'ready' | 'identifying' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const [identified, setIdentified] = useState('');

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const handleClose = useCallback(() => {
    stopCamera();
    onClose();
  }, [stopCamera, onClose]);

  const capture = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    // 最大1024pxにリサイズ（大きすぎるとAPIタイムアウトの原因になる）
    const MAX = 1024;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > MAX || h > MAX) {
      const ratio = Math.min(MAX / w, MAX / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];

    stopCamera();
    setStatus('identifying');

    try {
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      });
      const data = await res.json();
      const name: string = data.result ?? '不明';
      setIdentified(name);
      setStatus('done');
      setTimeout(() => {
        onIdentified(name);
        onClose();
      }, 1000);
    } catch {
      setStatus('error');
      setError('識別に失敗しました');
    }
  }, [stopCamera, onIdentified, onClose]);

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        setStatus('ready');

        timerRef.current = setInterval(() => {
          setTimeLeft(prev => {
            if (prev <= 1) {
              clearInterval(timerRef.current!);
              capture();
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      })
      .catch(() => {
        setStatus('error');
        setError('カメラへのアクセスが拒否されました');
      });

    return () => stopCamera();
  }, [capture, stopCamera]);

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <h2 className="text-base font-bold text-gray-800">📷 カメラで識別</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-5 py-6 space-y-4">
          {(status === 'loading' || status === 'ready') && (
            <>
              <div className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden">
                <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
                {status === 'loading' && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-white text-sm">カメラを起動中...</div>
                  </div>
                )}
                {status === 'ready' && (
                  <div className="absolute top-3 right-3 bg-black/60 text-white text-sm font-bold px-3 py-1 rounded-full">
                    {timeLeft}秒
                  </div>
                )}
                <div className="absolute inset-0 border-4 border-green-400/50 rounded-2xl pointer-events-none" />
              </div>
              <canvas ref={canvasRef} className="hidden" />
              <p className="text-xs text-gray-500 text-center">
                ごみにカメラを向けてください。{timeLeft}秒後に自動撮影します。
              </p>
              <button onClick={capture} className="btn-green w-full">
                今すぐ撮影して識別
              </button>
            </>
          )}

          {status === 'identifying' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-600 font-medium">AIが識別中です...</p>
            </div>
          )}

          {status === 'done' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center text-2xl">✅</div>
              <p className="text-sm text-gray-600 font-medium">識別完了！</p>
              {identified && identified !== '不明' && (
                <p className="text-base font-bold text-green-700 bg-green-50 rounded-xl px-4 py-2">{identified}</p>
              )}
              {identified === '不明' && (
                <p className="text-sm text-gray-400">識別できませんでした</p>
              )}
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center text-2xl">❌</div>
              <p className="text-sm text-red-600">{error}</p>
              <button onClick={handleClose} className="btn-secondary">閉じる</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
