/**
 * Browser-side PDF.js Text Extraction (Bangla-safe) + Tesseract.js OCR Fallback (Works 100% without AI)
 */
const loadedScripts = {};

function loadExternalScript(src) {
  if (loadedScripts[src]) return loadedScripts[src];
  loadedScripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
  return loadedScripts[src];
}

export function normalizeBanglaPdfText(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFC')
    // Merge Unicode composition-excluded Bengali nukta pairs (য+় -> য়, ড+় -> ড়, ঢ+় -> ঢ়)
    .replace(/\u09AF\u09BC/g, '\u09DF')
    .replace(/\u09A1\u09BC/g, '\u09DC')
    .replace(/\u09A2\u09BC/g, '\u09DD')
    // Re-attach separated Bengali combining marks / kar / hasanta / nukta / visarga / chandrabindu
    .replace(/([\u0980-\u09FF])\s+([\u0981-\u0983\u09BC\u09BE-\u09CC\u09CD\u09D7])/g, '$1$2')
    .replace(/([\u0980-\u09FF])\s+([\u0981-\u0983\u09BC\u09BE-\u09CC\u09CD\u09D7])/g, '$1$2')
    // Join Bengali virama (hasanta) + following consonant when split across PDF runs
    .replace(/\u09CD\s+([\u0995-\u09B9\u09DC-\u09DF])/g, '\u09CD$1')
    // Re-join any split English degree acronyms or decimal GPAs
    .replace(/\b([JSBHM])\s*\.\s*([SDC])\s*\.\s*C\b/gi, '$1.$2.C')
    .replace(/\b([BM])\s*\.\s*([AS])\s*\.\s*S\b/gi, '$1.$2.S')
    .replace(/\b([1-5])\s*\.\s*(\d{1,2})\b/g, '$1.$2');
}

function enhanceCanvasForOcr(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    // Luminance weighted for crisp black ink on bright background while keeping anti-aliased diacritics
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    let v;
    if (lum >= 205) {
      v = 255;
    } else if (lum <= 35) {
      v = 0;
    } else {
      v = Math.round(((lum - 35) / 170) * 255);
    }
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

function cloneCanvas(sourceCanvas) {
  const copy = document.createElement('canvas');
  copy.width = sourceCanvas.width;
  copy.height = sourceCanvas.height;
  copy.getContext('2d').drawImage(sourceCanvas, 0, 0);
  return copy;
}

function removeTableBordersForOcr(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  const erase = new Uint8Array(W * H);

  const lumAt = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return 255;
    const idx = (y * W + x) * 4;
    return 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
  };

  // Erase long horizontal table borders (1-4px thin gray/dark strokes, preserving solid header banners & glyph stems)
  for (let y = 0; y < H; y++) {
    let run = 0;
    let sx = 0;
    for (let x = 0; x < W; x++) {
      if (lumAt(x, y) < 225) {
        if (run === 0) sx = x;
        run++;
      } else {
        if (run >= 90) {
          for (let k = sx; k < x; k++) {
            if (Math.max(lumAt(k, y - 3), lumAt(k, y + 3)) >= 215) erase[y * W + k] = 1;
          }
        }
        run = 0;
      }
    }
    if (run >= 90) {
      for (let k = sx; k < W; k++) {
        if (Math.max(lumAt(k, y - 3), lumAt(k, y + 3)) >= 215) erase[y * W + k] = 1;
      }
    }
  }

  // Erase long vertical table borders
  for (let x = 0; x < W; x++) {
    let run = 0;
    let sy = 0;
    for (let y = 0; y < H; y++) {
      if (lumAt(x, y) < 225) {
        if (run === 0) sy = y;
        run++;
      } else {
        if (run >= 45) {
          for (let k = sy; k < y; k++) {
            if (Math.max(lumAt(x - 3, k), lumAt(x + 3, k)) >= 215) erase[k * W + x] = 1;
          }
        }
        run = 0;
      }
    }
    if (run >= 45) {
      for (let k = sy; k < H; k++) {
        if (Math.max(lumAt(x - 3, k), lumAt(x + 3, k)) >= 215) erase[k * W + x] = 1;
      }
    }
  }

  for (let p = 0; p < erase.length; p++) {
    if (erase[p]) {
      const idx = p * 4;
      d[idx] = 255;
      d[idx + 1] = 255;
      d[idx + 2] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

function cropPageHeaderCanvas(sourceCanvas) {
  // Crop Page 1 upper personal-info/names block (top 50%, left 82% excluding right-side photo box) without resampling blur
  const cropW = Math.round(sourceCanvas.width * 0.82);
  const cropH = Math.round(sourceCanvas.height * 0.50);
  const crop = document.createElement('canvas');
  crop.width = cropW;
  crop.height = cropH;
  const ctx = crop.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, crop.width, crop.height);
  ctx.drawImage(sourceCanvas, 0, 0, cropW, cropH, 0, 0, crop.width, crop.height);
  return enhanceCanvasForOcr(crop);
}

function cropPageLowerCanvas(sourceCanvas) {
  // Crop Page 1 lower half (addresses/education on 1-page Teletalk forms) for pure English borderless OCR
  const startY = Math.round(sourceCanvas.height * 0.45);
  const cropH = Math.max(100, Math.round(sourceCanvas.height * 0.50));
  const crop = document.createElement('canvas');
  crop.width = sourceCanvas.width;
  crop.height = cropH;
  const ctx = crop.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, crop.width, crop.height);
  ctx.drawImage(sourceCanvas, 0, startY, sourceCanvas.width, cropH, 0, 0, crop.width, cropH);
  return enhanceCanvasForOcr(removeTableBordersForOcr(crop));
}

const BANGLA_COMBINING_START_RE = /^[\u0981-\u0983\u09BC\u09BE-\u09CD\u09D7]/;

async function extractTextViaPdfJs(file, renderImagesIfNeeded = true, forceRender = false) {
  await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageTexts = [];
  const pageCanvases = [];

  for (let p = 1; p <= Math.min(pdf.numPages, 4); p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const rows = [];
    for (const item of tc.items || []) {
      const str = item.str || '';
      if (str.length === 0) continue;
      const isSpace = !str.trim();
      const y = Math.round(item.transform?.[5] || 0);
      const x = Number(item.transform?.[4] || 0);
      const w = Number(item.width || 0);
      const fontSize = Math.hypot(item.transform?.[0] || 0, item.transform?.[1] || 0) || item.height || 10;
      let row = rows.find(r => Math.abs(r.y - y) <= 3.5);
      if (!row) {
        row = { y, parts: [] };
        rows.push(row);
      }
      row.parts.push({ x, w, fontSize, str: isSpace ? ' ' : str, isSpace });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map(r => {
      const sorted = r.parts.sort((a, b) => a.x - b.x);
      let out = '';
      let lastNonSpace = null;
      let explicitSpacePending = false;
      for (let idx = 0; idx < sorted.length; idx++) {
        const cur = sorted[idx];
        if (cur.isSpace) {
          explicitSpacePending = true;
          continue;
        }
        if (lastNonSpace) {
          const prevEnd = lastNonSpace.w > 0 ? lastNonSpace.x + lastNonSpace.w : lastNonSpace.x;
          const gap = cur.x - prevEnd;
          const isBanglaPair = /[\u0980-\u09FF]/.test(lastNonSpace.str) || /[\u0980-\u09FF]/.test(cur.str);
          const spaceThreshold = isBanglaPair ? Math.max(0.75, (cur.fontSize || 10) * 0.08) : 1.8;
          const isContinuationMark = BANGLA_COMBINING_START_RE.test(cur.str) || /\u09CD$/.test(lastNonSpace.str);
          const isTightAsciiPunct = !isBanglaPair && (/^[.),:;\]}]/.test(cur.str) || /[([/]$/.test(lastNonSpace.str));
          const isDotChain = !isBanglaPair && (cur.str === '.' || lastNonSpace.str.endsWith('.')) && gap <= 2.4;
          const alreadySpaced = out.endsWith(' ') || cur.str.startsWith(' ');

          if (gap > 35) {
            out += '   ';
          } else if (
            !alreadySpaced &&
            !isContinuationMark &&
            !isTightAsciiPunct &&
            !isDotChain &&
            ((explicitSpacePending && gap > -0.5) || gap > spaceThreshold)
          ) {
            out += ' ';
          }
        }
        out += cur.str;
        lastNonSpace = cur;
        explicitSpacePending = false;
      }
      return out.trim();
    });
    pageTexts.push(lines.join('\n'));
  }

  const combinedText = normalizeBanglaPdfText(pageTexts.join('\n').trim());
  const hasBanglaUnicode = /[\u0980-\u09FF]{2,}/.test(combinedText);

  if (!forceRender && combinedText.length >= 60 && hasBanglaUnicode) {
    return { text: combinedText, canvases: [] };
  }
  if (!renderImagesIfNeeded) {
    return { text: combinedText, canvases: [] };
  }

  // Render pages at high DPI (~275-300 DPI) for crisp Bangla matras (ঁ, ী, ু) + word spacing + borderless English tables
  for (let p = 1; p <= Math.min(pdf.numPages, 4); p++) {
    const page = await pdf.getPage(p);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(4.0, Math.max(3.2, 2300 / (baseViewport.width || 595)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (p === 1) {
      // Put cropped high-res personal-info block first so Bangla names use maximum clarity
      pageCanvases.push({ canvas: cropPageHeaderCanvas(cloneCanvas(canvas)), lang: 'ben+eng', label: 'Page 1 header' });
      if (pdf.numPages === 1) {
        pageCanvases.push({ canvas: cropPageLowerCanvas(cloneCanvas(canvas)), lang: 'eng', label: 'Page 1 lower table' });
      }
      pageCanvases.push({ canvas: enhanceCanvasForOcr(canvas), lang: 'ben+eng', label: 'Page 1 full' });
    } else {
      // Page 2+ in Teletalk PDFs contains pure English tables; remove thin table borders & run pure English OCR
      pageCanvases.push({
        canvas: enhanceCanvasForOcr(removeTableBordersForOcr(canvas)),
        lang: 'eng',
        label: `Page ${p} table`
      });
    }
  }
  return { text: combinedText, canvases: pageCanvases };
}

export async function runBrowserOcr(file, embeddedImages = [], onStatus = null, options = {}) {
  const { forceOcr = false } = options;

  if (!forceOcr) {
    if (onStatus) onStatus('Reading PDF text & Bangla layers locally (No AI required)...');
    const pdfjsRes = await extractTextViaPdfJs(file, false, false);
    const hasBanglaUnicode = /[\u0980-\u09FF]{2,}/.test(pdfjsRes.text);
    if (pdfjsRes.text && pdfjsRes.text.length >= 60 && hasBanglaUnicode) {
      return { text: pdfjsRes.text, method: 'pdfjs-text' };
    }
  }

  if (onStatus) onStatus('Running high-DPI offline Bangla + English OCR on PDF pages...');
  const pdfjsRendered = await extractTextViaPdfJs(file, true, true);
  await loadExternalScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');

  const sources = pdfjsRendered.canvases.length > 0
    ? pdfjsRendered.canvases
    : embeddedImages.slice(0, 3).map((img, idx) => ({
        canvas: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`,
        lang: 'ben+eng',
        label: `Embedded image ${idx + 1}`
      }));

  if (!sources || sources.length === 0) {
    return { text: pdfjsRendered.text || '', method: 'pdfjs-text' };
  }

  const workers = {};
  const getWorker = async (langKey) => {
    if (workers[langKey]) return workers[langKey];
    let w;
    if (langKey === 'eng') {
      w = await window.Tesseract.createWorker('eng');
    } else {
      try {
        w = await window.Tesseract.createWorker('ben+eng');
      } catch {
        try {
          w = await window.Tesseract.createWorker('eng+ben');
        } catch {
          w = await window.Tesseract.createWorker('eng');
        }
      }
    }
    await w.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });
    workers[langKey] = w;
    return w;
  };

  try {
    const texts = [];
    for (let i = 0; i < sources.length; i++) {
      const item = sources[i];
      const imgInput = item?.canvas || item;
      const langKey = item?.lang || 'ben+eng';
      if (onStatus) onStatus(`Extracting text (${item?.label || `region ${i + 1}`} — ${i + 1}/${sources.length})...`);
      const w = await getWorker(langKey);
      const ret = await w.recognize(imgInput);
      if (ret?.data?.text) texts.push(ret.data.text);
    }
    const ocrCombined = normalizeBanglaPdfText(texts.join('\n\n'));
    const mergedText = [pdfjsRendered.text, ocrCombined].filter(Boolean).join('\n\n');
    return { text: mergedText, method: 'tesseract-browser' };
  } finally {
    await Promise.all(Object.values(workers).map(w => w.terminate().catch(() => {})));
  }
}

function loadImageMeta(blobOrUrl) {
  return new Promise((resolve) => {
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    const img = new Image();
    img.onload = () => {
      resolve({ img, url, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, revoke: typeof blobOrUrl !== 'string' });
    };
    img.onerror = () => {
      if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function measureWhiteBgRatio(imgOrCanvas) {
  try {
    const c = document.createElement('canvas');
    const w = 60;
    const h = 30;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(imgOrCanvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let light = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) light++;
    }
    return light / (w * h);
  } catch {
    return 0.5;
  }
}

function classifyCandidateImage(width, height, fileOrBlob, metaImg, photoSlot, signSlot, pageNum = 1) {
  if (!width || !height || width > 1050 || height > 1050) return;
  const ratio = width / height;
  // Photo: square-ish portrait (Teletalk standard is 300x300). Prefer exact 300x300 / large natural photo over small Govt seals.
  if (width >= 120 && height >= 120 && ratio >= 0.72 && ratio <= 1.35) {
    let score = (width === 300 && height === 300 ? 1000 : 0) + (width >= 200 ? 200 : 0) + (pageNum === 1 ? 50 : 0);
    if (metaImg && measureWhiteBgRatio(metaImg) > 0.78) score -= 150; // flat white/logo seal penalty vs portrait photo
    if (!photoSlot.best || score > photoSlot.best.score) {
      photoSlot.best = { blob: fileOrBlob, width, height, score };
    }
  } else if (width >= 140 && height >= 35 && height <= 360 && ratio >= 2.2 && ratio <= 7.5) {
    // Signature: Teletalk standard is 300x80 on bright white paper (skip green "Powered by Teletalk" footer logo)
    const whiteRatio = metaImg ? measureWhiteBgRatio(metaImg) : 0.7;
    if (whiteRatio < 0.45) return;
    const score = (width === 300 && height === 80 ? 1000 : 0) + Math.round(whiteRatio * 200) + (pageNum >= 2 ? 40 : 0);
    if (!signSlot.best || score > signSlot.best.score) {
      signSlot.best = { blob: fileOrBlob, width, height, score };
    }
  }
}

/**
 * Extracts embedded Candidate Photo (~300x300) and Signature (~300x80) from Teletalk/Govt Job PDFs
 */
export async function extractEmbeddedPdfMedia(file) {
  const result = { photoBlob: null, signatureBlob: null };
  if (!file) return result;

  const photoSlot = { best: null };
  const signSlot = { best: null };
  const seen = [];

  try {
    const buf = await file.arrayBuffer();
    const uint8 = new Uint8Array(buf);

    // 1. Fast raw JPEG SOI..EOI scan inside PDF bytes
    let start = 0;
    const rawJpegs = [];
    while (start < uint8.length - 4 && rawJpegs.length < 10) {
      let soi = -1;
      for (let i = start; i <= uint8.length - 3; i++) {
        if (uint8[i] === 0xff && uint8[i + 1] === 0xd8 && uint8[i + 2] === 0xff) {
          soi = i;
          break;
        }
      }
      if (soi === -1) break;
      let eoi = -1;
      for (let i = soi + 3; i <= uint8.length - 2; i++) {
        if (uint8[i] === 0xff && uint8[i + 1] === 0xd9) {
          eoi = i;
          break;
        }
      }
      if (eoi === -1) break;
      const slice = uint8.subarray(soi, eoi + 2);
      if (slice.length > 1500) {
        rawJpegs.push(new Blob([slice], { type: 'image/jpeg' }));
      }
      start = eoi + 2;
    }

    for (const blob of rawJpegs) {
      const meta = await loadImageMeta(blob);
      if (!meta) continue;
      classifyCandidateImage(meta.width, meta.height, blob, meta.img, photoSlot, signSlot, 1);
      if (meta.revoke) URL.revokeObjectURL(meta.url);
    }

    // 2. Fallback via pdf.js decoded image XObjects (handles FlateDecode / PNG / JPX images across pages 1-2)
    if (!photoSlot.best || !signSlot.best || photoSlot.best.score < 500 || signSlot.best.score < 500) {
      await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      const pdfjsLib = window.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const OPS = pdfjsLib.OPS || {};
      for (let pNum = 1; pNum <= Math.min(pdf.numPages, 2); pNum++) {
        const page = await pdf.getPage(pNum);
        const opList = await page.getOperatorList();
        const imgNames = new Set();
        for (let i = 0; i < (opList.fnArray?.length || 0); i++) {
          const fn = opList.fnArray[i];
          if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
            const name = opList.argsArray[i]?.[0];
            if (name) imgNames.add(name);
          }
        }
        if (imgNames.size === 0) continue;
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = 10;
        tmpCanvas.height = 10;
        const vp = page.getViewport({ scale: 0.1 });
        await page.render({ canvasContext: tmpCanvas.getContext('2d'), viewport: vp }).promise.catch(() => {});
        for (const name of imgNames) {
          const obj = page.objs.has(name) ? page.objs.get(name) : null;
          if (!obj || !obj.width || !obj.height) continue;
          if (obj.width > 1050 || obj.height > 1050) continue;
          const c = document.createElement('canvas');
          c.width = obj.width;
          c.height = obj.height;
          const cctx = c.getContext('2d');
          if (obj.data) {
            const rgba = new Uint8ClampedArray(obj.width * obj.height * 4);
            if (obj.data.length === obj.width * obj.height * 4) {
              rgba.set(obj.data);
            } else if (obj.data.length === obj.width * obj.height * 3) {
              for (let p = 0, q = 0; q < rgba.length; p += 3, q += 4) {
                rgba[q] = obj.data[p];
                rgba[q + 1] = obj.data[p + 1];
                rgba[q + 2] = obj.data[p + 2];
                rgba[q + 3] = 255;
              }
            } else {
              for (let p = 0, q = 0; p < obj.data.length && q < rgba.length; p++, q += 4) {
                rgba[q] = rgba[q + 1] = rgba[q + 2] = obj.data[p];
                rgba[q + 3] = 255;
              }
            }
            cctx.putImageData(new ImageData(rgba, obj.width, obj.height), 0, 0);
          } else if (obj.bitmap) {
            cctx.drawImage(obj.bitmap, 0, 0);
          } else {
            continue;
          }
          const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.94));
          if (blob) classifyCandidateImage(obj.width, obj.height, blob, c, photoSlot, signSlot, pNum);
        }
      }
    }

    if (photoSlot.best) result.photoBlob = photoSlot.best.blob;
    if (signSlot.best) result.signatureBlob = signSlot.best.blob;
  } catch (err) {
    console.warn('Embedded PDF photo/sign extraction warning:', err.message);
  }
  return result;
}
