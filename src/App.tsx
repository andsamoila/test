import React, { useState, useCallback } from 'react';
import { Upload, FileText, X, Eye, Download, Info } from 'lucide-react';
// @ts-ignore
import { parseMhtml } from 'mhtml-stream';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface MhtmlPart {
  headers: Record<string, string>;
  content: Uint8Array;
  contentType: string;
  location: string;
  id: string;
  blobUrl?: string;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [parts, setParts] = useState<MhtmlPart[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);

  const processMhtml = async (file: File) => {
    setLoading(true);
    setError(null);
    setParts([]);
    setRenderedHtml(null);

    try {
      const stream = file.stream();
      const extractedParts: MhtmlPart[] = [];
      
      // @ts-ignore - parseMhtml might have slightly different types depending on version
      for await (const part of parseMhtml(stream)) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(part.headers)) {
          headers[key.toLowerCase()] = value as string;
        }

        const contentType = headers['content-type'] || 'text/plain';
        const location = headers['content-location'] || '';
        const id = headers['content-id']?.replace(/[<>]/g, '') || '';
        const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();

        let content = part.content;

        // MIME parts can be encoded. We check the transfer encoding.
        if (encoding === 'base64') {
          try {
            const base64Str = new TextDecoder().decode(content).replace(/\s/g, '');
            const binaryStr = atob(base64Str);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            content = bytes;
          } catch (e) {
            console.warn("Failed to decode base64 part", e);
          }
        } else if (encoding === 'quoted-printable') {
          try {
            const qpStr = new TextDecoder().decode(content);
            const decoded = qpStr
              .replace(/=\r?\n/g, '')
              .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            content = new TextEncoder().encode(decoded);
          } catch (e) {
            console.warn("Failed to decode quoted-printable part", e);
          }
        }

        extractedParts.push({
          headers,
          content,
          contentType,
          location,
          id
        });
      }

      if (extractedParts.length === 0) {
        throw new Error("No parts found in MHTML file.");
      }

      // Create Blob URLs for all parts
      const partsWithUrls = extractedParts.map(part => {
        // @ts-ignore - Handle BlobPart type mismatch
        const blob = new Blob([part.content], { type: part.contentType.split(';')[0] });
        return { ...part, blobUrl: URL.createObjectURL(blob) };
      });

      setParts(partsWithUrls);

      // Find the main HTML part (usually the first one or the one with text/html)
      const mainHtmlPart = partsWithUrls.find(p => p.contentType.includes('text/html')) || partsWithUrls[0];
      
      if (mainHtmlPart && mainHtmlPart.contentType.includes('text/html')) {
        let htmlContent = new TextDecoder().decode(mainHtmlPart.content);

        // Use DOMParser to safely replace resource references
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlContent, 'text/html');
        
        const updateAttribute = (selector: string, attr: string) => {
          doc.querySelectorAll(selector).forEach(el => {
            const val = el.getAttribute(attr);
            if (val) {
              // Try to find a part that matches the attribute value
              const matchingPart = partsWithUrls.find(p => 
                p.location === val || 
                (p.location && p.location.endsWith(val)) || 
                `cid:${p.id}` === val
              );
              if (matchingPart?.blobUrl) {
                el.setAttribute(attr, matchingPart.blobUrl);
              }
            }
          });
        };

        updateAttribute('img', 'src');
        updateAttribute('link', 'href');
        updateAttribute('script', 'src');
        updateAttribute('source', 'src');
        updateAttribute('video', 'src');
        updateAttribute('audio', 'src');
        
        // Handle inline styles with url()
        doc.querySelectorAll('[style]').forEach(el => {
          let style = el.getAttribute('style') || '';
          partsWithUrls.forEach(part => {
            if (part.location && style.includes(part.location)) {
              style = style.split(part.location).join(part.blobUrl!);
            }
            if (part.id && style.includes(`cid:${part.id}`)) {
              style = style.split(`cid:${part.id}`).join(part.blobUrl!);
            }
          });
          el.setAttribute('style', style);
        });

        setRenderedHtml(doc.documentElement.outerHTML);
      } else {
        setError("Could not find HTML content in the file.");
      }

    } catch (err) {
      console.error(err);
      setError("Failed to parse MHTML file. Make sure it's a valid archive.");
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
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      setFile(droppedFile);
      processMhtml(droppedFile);
    }
  }, []);

  const reset = () => {
    setFile(null);
    setParts(prev => {
      prev.forEach(p => p.blobUrl && URL.revokeObjectURL(p.blobUrl));
      return [];
    });
    setRenderedHtml(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="Logo" className="w-10 h-10 object-contain" />
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
              MHT Archive Viewer
            </h1>
          </div>
          {file && (
            <button 
              onClick={reset}
              className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors"
            >
              <X className="w-4 h-4" />
              Close Archive
            </button>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!file ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh]">
            <div className="text-center mb-10 max-w-2xl">
              <h2 className="text-4xl font-extrabold text-slate-900 mb-4 tracking-tight">
                View MHTML files directly in your browser.
              </h2>
              <p className="text-lg text-slate-600">
                Easily open and inspect .mht and .mhtml archives. 
                Everything is processed locally in your browser - no files are ever uploaded to a server.
              </p>
            </div>

            <label 
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className="group relative w-full max-w-xl h-64 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-2xl bg-white hover:border-blue-500 hover:bg-blue-50/30 transition-all cursor-pointer overflow-hidden"
            >
              <input 
                type="file" 
                className="hidden" 
                accept=".mht,.mhtml" 
                onChange={onFileChange}
              />
              <div className="p-4 bg-slate-100 rounded-full mb-4 group-hover:scale-110 transition-transform duration-300">
                <Upload className="w-8 h-8 text-slate-500 group-hover:text-blue-600" />
              </div>
              <p className="text-lg font-medium text-slate-700">Click to upload or drag and drop</p>
              <p className="text-sm text-slate-500 mt-2">Supports .mht and .mhtml archives</p>
              
              <div className="absolute inset-0 bg-blue-600/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            </label>

            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-4xl">
              {[
                { icon: Info, title: "What is MHT?", desc: "MHT stands for MIME HTML, a web page archive format that combines HTML code and resources into a single file." },
                { icon: Eye, title: "Private & Secure", desc: "Your files stay on your machine. We don't store or transmit any of your data." },
                { icon: Download, title: "Export Assets", desc: "Easily extract images and other resources bundled within the archive." }
              ].map((feature, i) => (
                <div key={i} className="p-6 bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                  <feature.icon className="w-6 h-6 text-blue-600 mb-3" />
                  <h3 className="font-bold mb-2">{feature.title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row gap-6">
              {/* Sidebar: Details & Parts */}
              <div className="w-full lg:w-80 space-y-6">
                <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">File Details</h3>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-slate-500">Filename</p>
                      <p className="text-sm font-medium truncate">{file.name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Size</p>
                      <p className="text-sm font-medium">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Parts Found</p>
                      <p className="text-sm font-medium">{parts.length}</p>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                  <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Archive Assets</h3>
                  </div>
                  <div className="max-h-[500px] overflow-y-auto">
                    {parts.map((part, idx) => (
                      <div 
                        key={idx} 
                        className="p-3 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors group"
                      >
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-8 h-8 rounded flex items-center justify-center shrink-0",
                            part.contentType.includes('html') ? "bg-orange-100 text-orange-600" :
                            part.contentType.includes('image') ? "bg-green-100 text-green-600" :
                            part.contentType.includes('css') ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-600"
                          )}>
                            <FileText size={16} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium truncate">
                              {part.location || part.id || `Part ${idx + 1}`}
                            </p>
                            <p className="text-[10px] text-slate-400 truncate">
                              {part.contentType}
                            </p>
                          </div>
                          <a 
                            href={part.blobUrl} 
                            download={part.location?.split('/').pop() || `part-${idx}`}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-200 rounded transition-all"
                            title="Download asset"
                          >
                            <Download size={14} className="text-slate-600" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Main Content Area */}
              <div className="flex-1 bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm min-h-[70vh] flex flex-col">
                <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Eye className="w-4 h-4 text-blue-600" />
                    <span className="text-sm font-semibold">Live Preview</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {renderedHtml && (
                      <button 
                        onClick={() => {
                          navigator.clipboard.writeText(renderedHtml);
                          alert("HTML copied to clipboard!");
                        }}
                        className="text-xs font-medium text-slate-600 hover:text-blue-600 flex items-center gap-1 bg-white px-2 py-1 rounded border border-slate-200 shadow-sm transition-all"
                      >
                        Copy HTML
                      </button>
                    )}
                    {loading && (
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs text-slate-500">Processing...</span>
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="flex-1 bg-white relative">
                  {error ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                      <div className="bg-red-50 text-red-600 p-4 rounded-full mb-4">
                        <X className="w-8 h-8" />
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 mb-2">Something went wrong</h3>
                      <p className="text-slate-600 max-w-md">{error}</p>
                      <button 
                        onClick={() => processMhtml(file)}
                        className="mt-6 px-6 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors"
                      >
                        Try Again
                      </button>
                    </div>
                  ) : renderedHtml ? (
                    <iframe 
                      srcDoc={renderedHtml}
                      title="MHT Content"
                      className="w-full h-full border-0"
                      sandbox="allow-popups allow-scripts allow-forms"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
                        <p className="text-sm font-medium text-slate-500">Preparing content...</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto py-8 border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-sm text-slate-500">
            &copy; 2024 MHT Archive Viewer. Private, local-first archive processing.
          </p>
        </div>
      </footer>
    </div>
  );
}
