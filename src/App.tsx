import React, { useState, useCallback } from 'react';
import {
  Upload, FileText, X, Eye, Info, AlertTriangle, Download,
  Image as ImageIcon, Code, Grid, ArrowLeft, Copy, Check, FileCode, Film, Music, ExternalLink, Share2
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { parseMht, type MhtPart } from './mhtParser';
import { reconstructHtml, buildStandaloneHtml } from './htmlRenderer';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ProcessedPart extends MhtPart {
  blobUrl: string;
  fileName: string;
  textContent?: string;
  dataUrl?: string;
}

type ViewMode = 'preview' | 'extract' | 'convert';

/**
 * Convert Uint8Array to a data: URL.
 * Data URLs work for <a href> downloads and <img src> on Android.
 */
function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [parts, setParts] = useState<ProcessedPart[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [selectedPart, setSelectedPart] = useState<ProcessedPart | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [standaloneHtml, setStandaloneHtml] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  const processMhtml = async (inputFile: File) => {
    setLoading(true);
    setError(null);
    setParts([]);
    setRenderedHtml(null);
    setDebugInfo(null);
    setSelectedPart(null);
    setViewMode('preview');

    try {
      const text = await inputFile.text();
      if (!text || text.length === 0) throw new Error('File is empty.');

      const extractedParts = parseMht(text);
      if (extractedParts.length === 0) throw new Error('No parts found in the MHTML file.');

      setDebugInfo(`Found ${extractedParts.length} part${extractedParts.length > 1 ? 's' : ''} in the archive.`);

      const processedParts: ProcessedPart[] = extractedParts.map((part, idx) => {
        const mimeType = part.contentType.split(';')[0].trim();
        const blob = new Blob([part.decodedBody as unknown as BlobPart], { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);

        let fileName = `part-${idx + 1}`;
        if (part.location) {
          const urlParts = part.location.split('/');
          fileName = urlParts[urlParts.length - 1] || fileName;
          fileName = fileName.split('?')[0] || fileName;
          fileName = fileName.split('#')[0] || fileName;
        }
        if (!fileName.includes('.')) {
          const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
          fileName = `${fileName}.${ext}`;
        }

        let textContent: string | undefined;
        if (mimeType.startsWith('text/') || mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('css')) {
          try { textContent = new TextDecoder().decode(part.decodedBody); } catch { /* skip */ }
        }

        // Generate data URL for all files (needed for Android download)
        let dataUrl: string | undefined;
        try {
          dataUrl = toDataUrl(part.decodedBody, mimeType);
        } catch { /* skip for very large files */ }

        return { ...part, blobUrl, fileName, textContent, dataUrl };
      });

      setParts(processedParts);

      const mainHtmlPart = processedParts.find(p =>
        p.contentType.toLowerCase().includes('text/html')
      );

      if (!mainHtmlPart) {
        setViewMode('extract');
        setError('No HTML content found. Browse extracted assets below.');
        return;
      }

      const rawHtml = new TextDecoder().decode(mainHtmlPart.decodedBody);

      // Use the advanced HTML reconstruction engine
      const reconstructed = reconstructHtml(rawHtml, mainHtmlPart, processedParts);

      setRenderedHtml(reconstructed);
    } catch (err: any) {
      console.error('MHT Parse Error:', err);
      setError(err?.message || 'Failed to parse the file.');
    } finally {
      setLoading(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      processMhtml(selectedFile);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      setFile(droppedFile);
      processMhtml(droppedFile);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const reset = () => {
    parts.forEach(p => URL.revokeObjectURL(p.blobUrl));
    setFile(null);
    setParts([]);
    setRenderedHtml(null);
    setError(null);
    setDebugInfo(null);
    setSelectedPart(null);
    setViewMode('preview');
    setStandaloneHtml(null);
    setConverting(false);
  };

  const copyToClipboard = (text: string, index: number) => {
    try {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
      }).catch(() => {
        fallbackCopy(text, index);
      });
    } catch {
      fallbackCopy(text, index);
    }
  };

  const fallbackCopy = (text: string, index: number) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  /**
   * Opens a helper page in a new tab that triggers a proper download.
   * The helper page creates a blob URL with application/octet-stream
   * and uses <a download="filename"> to force the browser to save with the correct name.
   */
  const openDownloadHelper = (content: string | Uint8Array, fileName: string) => {
    // Encode the content into the helper page
    const isString = typeof content === 'string';
    const helperHtml = `<!DOCTYPE html>
<html><head><title>Save ${fileName}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;padding:20px;">
<div style="text-align:center;max-width:400px;width:100%;">
<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto 16px;display:block;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
<p style="font-size:16px;font-weight:600;color:#1e293b;margin:0 0 8px;">${fileName}</p>
<p id="status" style="color:#64748b;font-size:14px;margin:0 0 20px;">Tap the button below to save the file.</p>
<a id="dl" style="display:inline-block;padding:14px 28px;background:#2563eb;color:#fff;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;width:100%;box-sizing:border-box;text-align:center;">Save ${fileName}</a>
<p style="color:#94a3b8;font-size:12px;margin-top:20px;">You can close this tab after saving.</p>
</div>
<script>
try {
  var dl = document.getElementById('dl');
  ${isString
    ? `var blob = new Blob([${JSON.stringify(content)}], {type:'application/octet-stream'});`
    : `var arr = new Uint8Array(${JSON.stringify(Array.from(content as Uint8Array))});
  var blob = new Blob([arr], {type:'application/octet-stream'});`
  }
  var url = URL.createObjectURL(blob);
  dl.href = url;
  dl.download = ${JSON.stringify(fileName)};
  dl.addEventListener('click', function() {
    setTimeout(function() {
      document.getElementById('status').textContent = 'Download started! You can close this tab.';
      document.getElementById('status').style.color = '#16a34a';
    }, 500);
  });
} catch(e) {
  document.getElementById('status').textContent = 'Error: ' + e.message;
  document.getElementById('status').style.color = '#dc2626';
}
</script>
</body></html>`;

    // Open the helper page as a blob URL — gives it its own unsandboxed origin
    const pageBlob = new Blob([helperHtml], { type: 'text/html;charset=utf-8' });
    const pageUrl = URL.createObjectURL(pageBlob);
    window.open(pageUrl, '_blank');
  };

  /** Share using Web Share API (works great on Android) */
  const handleShare = async (part: ProcessedPart) => {
    const mimeType = part.contentType.split(';')[0].trim();
    // Use application/octet-stream for non-image files to prevent Android
    // from changing the file extension (e.g. .html → .txt)
    const isImg = mimeType.startsWith('image/');
    const shareType = isImg ? mimeType : 'application/octet-stream';

    try {
      const blob = new Blob([part.decodedBody as unknown as BlobPart], { type: shareType });
      const shareFile = new File([blob], part.fileName, { type: shareType });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [shareFile] })) {
        await navigator.share({
          title: part.fileName,
          files: [shareFile],
        });
        return;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.warn('Share failed:', e);
    }

    // Fallback: open download helper page
    openDownloadHelper(part.decodedBody, part.fileName);
  };

  /** Open file in a new standalone page that allows saving */
  const openInNewTab = (part: ProcessedPart) => {
    window.open(part.blobUrl, '_blank');
  };

  const getTypeInfo = (contentType: string) => {
    const ct = contentType.toLowerCase();
    if (ct.includes('html')) return { label: 'HTML', color: 'bg-orange-100 text-orange-700', Icon: Code };
    if (ct.includes('css')) return { label: 'CSS', color: 'bg-blue-100 text-blue-700', Icon: FileCode };
    if (ct.includes('javascript')) return { label: 'JS', color: 'bg-yellow-100 text-yellow-700', Icon: Code };
    if (ct.includes('image/svg')) return { label: 'SVG', color: 'bg-purple-100 text-purple-700', Icon: ImageIcon };
    if (ct.includes('image')) return { label: 'Image', color: 'bg-green-100 text-green-700', Icon: ImageIcon };
    if (ct.includes('video')) return { label: 'Video', color: 'bg-pink-100 text-pink-700', Icon: Film };
    if (ct.includes('audio')) return { label: 'Audio', color: 'bg-pink-100 text-pink-700', Icon: Music };
    if (ct.includes('json')) return { label: 'JSON', color: 'bg-emerald-100 text-emerald-700', Icon: FileCode };
    if (ct.includes('xml')) return { label: 'XML', color: 'bg-teal-100 text-teal-700', Icon: FileCode };
    if (ct.includes('text')) return { label: 'Text', color: 'bg-slate-100 text-slate-700', Icon: FileText };
    return { label: 'File', color: 'bg-slate-100 text-slate-700', Icon: FileText };
  };

  const isImage = (ct: string) => ct.toLowerCase().includes('image');
  const isText = (part: ProcessedPart) => !!part.textContent;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  // ————————————————— LANDING PAGE —————————————————
  if (!file) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
        <header className="bg-white border-b border-slate-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center">
            <div className="flex items-center gap-2">
              <div className="bg-gradient-to-br from-blue-600 to-indigo-600 p-1.5 rounded-lg shadow-sm">
                <FileText className="text-white w-5 h-5" />
              </div>
              <h1 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
                MHT Viewer
              </h1>
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
          <div className="text-center mb-8 max-w-lg">
            <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 mb-3 tracking-tight">
              View &amp; extract MHT files
            </h2>
            <p className="text-base text-slate-600">
              Open .mht and .mhtml archives, preview pages, and save every image and file. Fully local — nothing leaves your device.
            </p>
          </div>

          <label
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="group relative w-full max-w-md h-52 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-2xl bg-white active:border-blue-500 active:bg-blue-50/30 hover:border-blue-500 hover:bg-blue-50/30 transition-all cursor-pointer"
          >
            <input type="file" className="hidden" accept=".mht,.mhtml,.mht2,application/x-mimearchive,message/rfc822" onChange={onFileChange} />
            <div className="p-3 bg-slate-100 rounded-full mb-3">
              <Upload className="w-7 h-7 text-slate-500" />
            </div>
            <p className="text-base font-medium text-slate-700">Tap to select a file</p>
            <p className="text-sm text-slate-500 mt-1">.mht and .mhtml supported</p>
          </label>

          <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl">
            {[
              { icon: Eye, title: 'Preview', desc: 'See the saved page as it looked originally.' },
              { icon: Grid, title: 'Extract', desc: 'Browse & save every image and resource.' },
              { icon: Share2, title: 'Share', desc: 'Use your phone\'s share menu to save files.' },
            ].map((f, i) => (
              <div key={i} className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm">
                <f.icon className="w-5 h-5 text-blue-600 mb-2" />
                <h3 className="font-bold text-sm mb-1">{f.title}</h3>
                <p className="text-xs text-slate-600 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </main>

        <footer className="py-4 border-t border-slate-200 bg-white">
          <div className="max-w-7xl mx-auto px-4 text-center">
            <p className="text-xs text-slate-400">Fully private — no data leaves your device.</p>
          </div>
        </footer>
      </div>
    );
  }

  // ————————————————— DETAIL VIEW FOR A SINGLE PART —————————————————
  if (selectedPart) {
    const typeInfo = getTypeInfo(selectedPart.contentType);
    const image = isImage(selectedPart.contentType);
    const text = isText(selectedPart);
    const mimeType = selectedPart.contentType.split(';')[0].trim();

    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
        <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
          <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
            <button onClick={() => setSelectedPart(null)} className="flex items-center gap-1.5 text-sm font-medium text-slate-600 active:text-blue-600">
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <span className={cn('text-xs font-bold px-2.5 py-1 rounded-full', typeInfo.color)}>
              {typeInfo.label}
            </span>
          </div>
        </header>

        <main className="flex-1 max-w-5xl mx-auto px-4 py-6 w-full">
          <div className="mb-5">
            <h2 className="text-lg font-bold text-slate-900 break-all">{selectedPart.fileName}</h2>
            <p className="text-sm text-slate-500 mt-1">
              {mimeType} · {formatBytes(selectedPart.decodedBody.length)}
            </p>
          </div>

          {/* Image preview — shown inline so user can long-press to save on Android */}
          {image && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="bg-blue-50 border-b border-blue-100 px-4 py-3 flex items-start gap-2">
                <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                <p className="text-sm text-blue-800">
                  <strong>To save:</strong> Long-press the image below and choose <em>"Download image"</em> or <em>"Save image"</em>
                </p>
              </div>
              <div className="bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:20px_20px] flex items-center justify-center p-4 min-h-[200px]">
                <img
                  src={selectedPart.dataUrl || selectedPart.blobUrl}
                  alt={selectedPart.fileName}
                  className="max-w-full max-h-[65vh] object-contain"
                />
              </div>
            </div>
          )}

          {/* Text / code preview */}
          {text && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
                <span className="text-sm font-medium text-slate-600">Source code</span>
                <button
                  onClick={() => copyToClipboard(selectedPart.textContent!, -1)}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-white border border-slate-200 text-slate-600 active:text-blue-600 transition-colors"
                >
                  {copiedIndex === -1 ? <><Check className="w-3.5 h-3.5 text-green-600" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy all</>}
                </button>
              </div>
              <pre className="p-4 text-xs leading-relaxed overflow-auto max-h-[60vh] bg-slate-900 text-slate-100 font-mono whitespace-pre-wrap break-all">
                {selectedPart.textContent}
              </pre>
            </div>
          )}

          {!image && !text && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">
              <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-600 mb-2">Binary file — cannot preview this type.</p>
              <p className="text-sm text-slate-400">{mimeType}</p>
            </div>
          )}

          {/* Action buttons — large touch targets for mobile */}
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Save file — uses share API or download helper */}
            <button
              onClick={() => handleShare(selectedPart)}
              className="flex items-center justify-center gap-2 px-5 py-3.5 bg-blue-600 text-white rounded-xl active:bg-blue-700 transition-colors text-sm font-semibold shadow-sm"
            >
              <Download className="w-5 h-5" />
              Save {selectedPart.fileName.split('.').pop()?.toUpperCase() || 'file'}
            </button>

            {/* Open in new tab */}
            <button
              onClick={() => openInNewTab(selectedPart)}
              className="flex items-center justify-center gap-2 px-5 py-3.5 bg-white text-slate-700 border border-slate-200 rounded-xl active:bg-slate-50 transition-colors text-sm font-semibold"
            >
              <ExternalLink className="w-5 h-5" />
              Open in new tab
            </button>

            {/* Copy content for text files */}
            {text && (
              <button
                onClick={() => copyToClipboard(selectedPart.textContent!, -1)}
                className="flex items-center justify-center gap-2 px-5 py-3.5 bg-white text-slate-700 border border-slate-200 rounded-xl active:bg-slate-50 transition-colors text-sm font-semibold sm:col-span-2"
              >
                {copiedIndex === -1 ? <><Check className="w-5 h-5 text-green-600" /> Copied to clipboard!</> : <><Copy className="w-5 h-5" /> Copy content</>}
              </button>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ————————————————— MAIN APP WITH TABS —————————————————
  const images = parts.filter(p => isImage(p.contentType));
  const textFiles = parts.filter(p => isText(p) && !isImage(p.contentType));
  const otherFiles = parts.filter(p => !isImage(p.contentType) && !isText(p));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-gradient-to-br from-blue-600 to-indigo-600 p-1.5 rounded-lg shadow-sm">
              <FileText className="text-white w-5 h-5" />
            </div>
            <h1 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
              MHT Viewer
            </h1>
          </div>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 text-sm font-medium text-slate-500 active:text-red-500 px-2 py-1.5 rounded-lg"
          >
            <X className="w-4 h-4" />
            Close
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex">
          <button
            onClick={() => setViewMode('preview')}
            className={cn(
              'flex-1 sm:flex-none px-4 py-3 text-sm font-medium border-b-2 transition-colors text-center',
              viewMode === 'preview' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'
            )}
          >
            <span className="flex items-center justify-center gap-2"><Eye className="w-4 h-4" /> Preview</span>
          </button>
          <button
            onClick={() => setViewMode('extract')}
            className={cn(
              'flex-1 sm:flex-none px-4 py-3 text-sm font-medium border-b-2 transition-colors text-center',
              viewMode === 'extract' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'
            )}
          >
            <span className="flex items-center justify-center gap-2">
              <Grid className="w-4 h-4" />
              Extract
              <span className="bg-slate-200 text-slate-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full">{parts.length}</span>
            </span>
          </button>
          <button
            onClick={() => {
              setViewMode('convert');
              // Build standalone HTML on first click
              if (!standaloneHtml && renderedHtml && parts.length > 0) {
                setConverting(true);
                setTimeout(() => {
                  try {
                    const mainHtmlPart = parts.find(p => p.contentType.toLowerCase().includes('text/html'));
                    if (mainHtmlPart) {
                      const rawHtml = new TextDecoder().decode(mainHtmlPart.decodedBody);
                      const result = buildStandaloneHtml(rawHtml, mainHtmlPart, parts);
                      setStandaloneHtml(result);
                    }
                  } catch (e) {
                    console.error('Conversion failed:', e);
                  }
                  setConverting(false);
                }, 100);
              }
            }}
            className={cn(
              'flex-1 sm:flex-none px-4 py-3 text-sm font-medium border-b-2 transition-colors text-center',
              viewMode === 'convert' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'
            )}
          >
            <span className="flex items-center justify-center gap-2">
              <FileCode className="w-4 h-4" />
              Convert to HTML
            </span>
          </button>
        </div>
      </div>

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 w-full">
        {debugInfo && !error && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-700 flex items-center gap-2 mb-4">
            <Info className="w-4 h-4 shrink-0" />
            {debugInfo}
          </div>
        )}

        {/* PREVIEW TAB */}
        {viewMode === 'preview' && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm min-h-[75vh] flex flex-col">
            <div className="p-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <span className="text-sm font-semibold flex items-center gap-2"><Eye className="w-4 h-4 text-blue-600" /> Live Preview</span>
              {renderedHtml && (
                <button
                  onClick={() => copyToClipboard(renderedHtml, -2)}
                  className="text-xs font-medium text-slate-600 flex items-center gap-1 bg-white px-2 py-1 rounded border border-slate-200 shadow-sm"
                >
                  {copiedIndex === -2 ? <><Check className="w-3 h-3 text-green-600" /> Copied</> : <><Copy className="w-3 h-3" /> HTML</>}
                </button>
              )}
            </div>
            <div className="flex-1 relative">
              {error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                  <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
                  <p className="text-slate-600 max-w-md">{error}</p>
                  <button onClick={() => setViewMode('extract')} className="mt-4 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                    View extracted files →
                  </button>
                </div>
              ) : renderedHtml ? (
                <iframe srcDoc={renderedHtml} title="MHT Content" className="w-full h-full border-0" sandbox="allow-popups allow-scripts allow-forms" style={{ minHeight: '75vh' }} />
              ) : loading ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-slate-500">Parsing...</p>
                  </div>
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-sm text-slate-400">No preview available</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* EXTRACT TAB */}
        {viewMode === 'extract' && (
          <div className="space-y-6">
            {/* Tip for mobile */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
              <p className="font-semibold mb-1">📱 How to save files on your phone</p>
              <p className="text-blue-700 text-xs leading-relaxed">
                Tap any file to open it. Then use the <strong>"Share / Save"</strong> button to save it to your device, or long-press images to download them directly.
              </p>
            </div>

            {/* Images section */}
            {images.length > 0 && (
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
                  <ImageIcon className="w-4 h-4" /> Images ({images.length})
                </h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                  {images.map((part, idx) => (
                    <button
                      key={idx}
                      onClick={() => setSelectedPart(part)}
                      className="bg-white rounded-lg border border-slate-200 shadow-sm active:shadow-md active:border-blue-300 transition-all overflow-hidden text-left"
                    >
                      <div className="aspect-square bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:12px_12px] flex items-center justify-center p-1.5">
                        <img src={part.blobUrl} alt={part.fileName} className="max-w-full max-h-full object-contain" loading="lazy" />
                      </div>
                      <div className="p-2 border-t border-slate-100">
                        <p className="text-[10px] font-medium text-slate-700 truncate">{part.fileName}</p>
                        <p className="text-[9px] text-slate-400">{formatBytes(part.decodedBody.length)}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Text / Code files section */}
            {textFiles.length > 0 && (
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
                  <Code className="w-4 h-4" /> Code &amp; Text ({textFiles.length})
                </h3>
                <div className="space-y-2">
                  {textFiles.map((part, idx) => {
                    const typeInfo = getTypeInfo(part.contentType);
                    return (
                      <button
                        key={idx}
                        onClick={() => setSelectedPart(part)}
                        className="w-full bg-white rounded-xl border border-slate-200 shadow-sm active:shadow-md active:border-blue-300 transition-all overflow-hidden text-left"
                      >
                        <div className="flex items-center gap-3 p-3">
                          <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', typeInfo.color)}>
                            <typeInfo.Icon size={16} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-800 truncate">{part.fileName}</p>
                            <p className="text-[11px] text-slate-400">{part.contentType.split(';')[0]} · {formatBytes(part.decodedBody.length)}</p>
                          </div>
                          <div className="text-slate-400 shrink-0">
                            <ArrowLeft className="w-4 h-4 rotate-180" />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Other files */}
            {otherFiles.length > 0 && (
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4" /> Other Files ({otherFiles.length})
                </h3>
                <div className="space-y-2">
                  {otherFiles.map((part, idx) => {
                    const typeInfo = getTypeInfo(part.contentType);
                    return (
                      <button
                        key={idx}
                        onClick={() => setSelectedPart(part)}
                        className="w-full bg-white rounded-xl border border-slate-200 shadow-sm p-3 flex items-center gap-3 active:shadow-md active:border-blue-300 transition-all text-left"
                      >
                        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', typeInfo.color)}>
                          <typeInfo.Icon size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-800 truncate">{part.fileName}</p>
                          <p className="text-[11px] text-slate-400">{part.contentType.split(';')[0]} · {formatBytes(part.decodedBody.length)}</p>
                        </div>
                        <div className="text-slate-400 shrink-0">
                          <ArrowLeft className="w-4 h-4 rotate-180" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {parts.length === 0 && !loading && (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500">No files extracted.</p>
              </div>
            )}
          </div>
        )}

        {/* CONVERT TAB */}
        {viewMode === 'convert' && (
          <div className="space-y-4">
            {converting ? (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
                <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="text-base font-semibold text-slate-700">Converting to HTML...</p>
                <p className="text-sm text-slate-500 mt-2">Embedding all images and styles inline. This may take a moment for large files.</p>
              </div>
            ) : standaloneHtml ? (
              <>
                {/* Success */}
                <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 flex items-start gap-3">
                  <Check className="w-5 h-5 shrink-0 mt-0.5 text-green-600" />
                  <div>
                    <p className="font-semibold">Conversion complete!</p>
                    <p className="text-green-700 text-xs mt-1">
                      Your MHT file has been converted to a self-contained HTML file ({formatBytes(new TextEncoder().encode(standaloneHtml).length)}).
                      All images and styles are embedded inline — the file works completely offline.
                    </p>
                  </div>
                </div>

                {/* Save actions */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
                  <h3 className="text-sm font-bold text-slate-800">Save your HTML file</h3>

                  {/* Share / Save — best for Android */}
                  <button
                    onClick={async () => {
                      const htmlFileName = (file?.name?.replace(/\.(mht|mhtml)$/i, '') || 'page') + '.html';

                      // Use application/octet-stream so Android saves with the .html extension
                      // instead of renaming to .txt
                      const shareBlob = new Blob([standaloneHtml], { type: 'application/octet-stream' });

                      // Try Web Share API first (Android)
                      try {
                        const htmlFile = new File([shareBlob], htmlFileName, { type: 'application/octet-stream' });
                        if (navigator.share && navigator.canShare && navigator.canShare({ files: [htmlFile] })) {
                          await navigator.share({ title: htmlFileName, files: [htmlFile] });
                          return;
                        }
                      } catch (e: any) {
                        if (e?.name === 'AbortError') return;
                      }

                      // Try File System Access API (Chrome desktop)
                      if ('showSaveFilePicker' in window) {
                        try {
                          const handle = await (window as any).showSaveFilePicker({
                            suggestedName: htmlFileName,
                            types: [{ description: 'HTML file', accept: { 'text/html': ['.html'] } }],
                          });
                          const writable = await handle.createWritable();
                          await writable.write(new Blob([standaloneHtml], { type: 'text/html;charset=utf-8' }));
                          await writable.close();
                          return;
                        } catch (e: any) {
                          if (e?.name === 'AbortError') return;
                        }
                      }

                      // Fallback: open download helper page
                      openDownloadHelper(standaloneHtml, htmlFileName);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-5 py-3.5 bg-blue-600 text-white rounded-xl active:bg-blue-700 transition-colors text-sm font-semibold shadow-sm"
                  >
                    <Download className="w-5 h-5" />
                    Save as .html file
                  </button>

                  {/* Open in new tab — to preview and use browser save */}
                  <button
                    onClick={() => {
                      const blob = new Blob([standaloneHtml], { type: 'text/html;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      window.open(url, '_blank');
                    }}
                    className="w-full flex items-center justify-center gap-2 px-5 py-3.5 bg-white text-slate-700 border border-slate-200 rounded-xl active:bg-slate-50 transition-colors text-sm font-semibold"
                  >
                    <ExternalLink className="w-5 h-5" />
                    Preview in new tab
                  </button>

                  <div className="bg-slate-50 rounded-lg px-4 py-3 space-y-2">
                    <p className="text-xs font-semibold text-slate-600">📱 How to save on Android</p>
                    <ol className="text-xs text-slate-500 leading-relaxed space-y-1 list-decimal list-inside">
                      <li>Tap <strong>"Save as .html file"</strong> above</li>
                      <li>Your phone's share menu will open</li>
                      <li>Choose <strong>"Save to Files"</strong>, <strong>"Downloads"</strong>, or <strong>"Google Drive"</strong></li>
                    </ol>
                  </div>
                </div>

                {/* Preview of converted HTML */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                  <div className="p-3 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
                    <Eye className="w-4 h-4 text-blue-600" />
                    <span className="text-sm font-semibold">Preview of converted HTML</span>
                  </div>
                  <iframe
                    srcDoc={standaloneHtml}
                    title="Converted HTML preview"
                    className="w-full border-0"
                    sandbox="allow-popups allow-scripts"
                    style={{ minHeight: '50vh' }}
                  />
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">
                <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
                <p className="text-slate-600 mb-4">
                  {renderedHtml
                    ? 'Ready to convert. Tap below to generate a self-contained HTML file.'
                    : 'No HTML content available to convert. Try uploading a different MHT file.'}
                </p>
                {renderedHtml && (
                  <button
                    onClick={() => {
                      setConverting(true);
                      setTimeout(() => {
                        try {
                          const mainHtmlPart = parts.find(p => p.contentType.toLowerCase().includes('text/html'));
                          if (mainHtmlPart) {
                            const rawHtml = new TextDecoder().decode(mainHtmlPart.decodedBody);
                            const result = buildStandaloneHtml(rawHtml, mainHtmlPart, parts);
                            setStandaloneHtml(result);
                          }
                        } catch (e) {
                          console.error('Conversion failed:', e);
                        }
                        setConverting(false);
                      }, 100);
                    }}
                    className="px-6 py-3 bg-blue-600 text-white rounded-xl active:bg-blue-700 text-sm font-semibold shadow-sm"
                  >
                    Convert to HTML
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="py-4 border-t border-slate-200 bg-white mt-auto">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-xs text-slate-400">MHT Viewer — Private, local-first. No data leaves your device.</p>
        </div>
      </footer>
    </div>
  );
}
