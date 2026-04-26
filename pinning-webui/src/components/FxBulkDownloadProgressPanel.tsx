/**
 * Fixed-position progress card for the FxFiles "Download All" feature.
 * Rendered once at the Layout level so it stays visible regardless of which
 * authenticated page the user navigates to mid-download.
 */

import { useFxBulkDownload } from '../context/FxBulkDownloadContext';
import { useLanguage } from '../context/LanguageContext';

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

export default function FxBulkDownloadProgressPanel() {
  const { progress, cancel, dismiss } = useFxBulkDownload();
  const { t } = useLanguage();

  if (!progress) return null;

  const p = progress;
  const pct = p.bytesTotal > 0
    ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100))
    : (p.filesTotal > 0 ? Math.min(100, Math.floor((p.filesDone / p.filesTotal) * 100)) : 0);
  const isRunning = p.phase === 'listing' || p.phase === 'downloading' || p.phase === 'finalizing';
  const isFinal = p.phase === 'done' || p.phase === 'aborted' || p.phase === 'error';

  const phaseLabel =
    p.phase === 'listing' ? (t.pins.downloadAllListing || 'Listing buckets…')
    : p.phase === 'downloading' ? (t.pins.downloadAllDownloading || 'Decrypting files…')
    : p.phase === 'finalizing' ? (t.pins.downloadAllFinalizing || 'Building archive…')
    : p.phase === 'done' ? (t.pins.downloadAllDone || 'Download complete')
    : p.phase === 'aborted' ? (t.pins.downloadAllAborted || 'Download cancelled')
    : (t.pins.downloadAllError || 'Download failed');

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-white border border-gray-200 rounded-xl shadow-2xl p-4 z-50">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            {t.pins.downloadAll || 'Download All'}
          </div>
          <div className="text-xs text-gray-500">{phaseLabel}</div>
        </div>
        {isFinal && (
          <button
            onClick={dismiss}
            className="text-gray-400 hover:text-gray-700"
            title={t.pins.dismiss || 'Dismiss'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {p.bufferingFallback && p.phase === 'downloading' && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-2">
          {t.pins.downloadAllStreamingNote ||
            'Your browser does not support streaming saves; the archive will be built in memory.'}
        </div>
      )}

      <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden mb-2">
        <div
          className={`h-2 rounded-full transition-all ${p.phase === 'error' ? 'bg-red-500' : p.phase === 'aborted' ? 'bg-gray-500' : 'bg-green-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="text-xs text-gray-600 mb-2">
        {p.filesTotal > 0
          ? `${p.filesDone} / ${p.filesTotal} ${t.pins.files || 'files'}`
          : `${p.bucketsDone} / ${p.bucketsTotal} ${t.pins.buckets || 'buckets'}`}
        {p.bytesTotal > 0 && (
          <span className="ml-2">({mb(p.bytesDone)} / {mb(p.bytesTotal)} MB)</span>
        )}
      </div>

      {p.currentFile && isRunning && (
        <div className="text-xs text-gray-500 truncate mb-2" title={p.currentFile}>
          {p.currentFile}
        </div>
      )}

      {p.failures.length > 0 && (
        <div className="text-xs text-red-600 mb-2">
          {(t.pins.downloadAllPartialFailures || '{count} files could not be decrypted; see _failures.txt inside the ZIP.').replace('{count}', String(p.failures.length))}
        </div>
      )}

      {isRunning && (
        <button
          onClick={cancel}
          className="w-full px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          {t.pins.cancel || 'Cancel'}
        </button>
      )}
    </div>
  );
}
