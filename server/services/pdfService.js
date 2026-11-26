const path = require('path');
const zlib = require('zlib');
const { createWorker } = require('tesseract.js');

const SERVER_ROOT = path.join(__dirname, '..');

const PdfService = {
  /**
   * Processes a PDF file buffer to extract raw text and embedded page images
   * @param {Buffer} pdfBuffer 
   * @returns {Promise<{ text: string, images: Array<{ buffer: Buffer, base64: string, mimeType: string }>, hasImages: boolean, hasText: boolean }>}
   */
  async processPdf(pdfBuffer) {
    const images = this.extractEmbeddedImages(pdfBuffer);
    const text = this.extractTextFromPdfStream(pdfBuffer);

    return {
      text,
      images,
      hasImages: images.length > 0,
      hasText: text.trim().length > 20
    };
  },

  /**
   * Runs local Tesseract.js OCR (English + Bengali) on extracted page images
   * @param {Array<{ buffer: Buffer }>} images
   * @returns {Promise<string>}
   */
  async runOcrOnImages(images) {
    if (!images || images.length === 0) return '';

    const worker = await createWorker(['eng', 'ben'], 1, {
      langPath: SERVER_ROOT,
      cachePath: SERVER_ROOT
    });

    try {
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
      const pageTexts = [];
      for (let i = 0; i < Math.min(images.length, 6); i++) {
        const ret = await worker.recognize(images[i].buffer);
        if (ret && ret.data && ret.data.text) {
          pageTexts.push(ret.data.text);
        }
      }
      return pageTexts.join('\n\n');
    } finally {
      await worker.terminate();
    }
  },

  /**
   * Extracts embedded JPEG images (often present in scanned applicant copies)
   */
  extractEmbeddedImages(buf) {
    const images = [];
    let start = 0;

    while (start < buf.length) {
      const soi = buf.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), start);
      if (soi === -1) break;
      const eoi = buf.indexOf(Buffer.from([0xFF, 0xD9]), soi);
      if (eoi === -1) break;

      const imgData = buf.subarray(soi, eoi + 2);
      // Filter out tiny thumbnail or artifact fragments (< 4KB)
      if (imgData.length > 4000) {
        images.push({
          buffer: imgData,
          base64: imgData.toString('base64'),
          mimeType: 'image/jpeg',
          size: imgData.length
        });
      }
      start = eoi + 2;
    }

    return images;
  },

  /**
   * Extracts text from both uncompressed and FlateDecode-compressed PDF streams
   */
  extractTextFromPdfStream(buf) {
    const chunks = [];

    // 1. Scan raw stream blocks (handles FlateDecode compressed streams as well)
    let pos = 0;
    while (pos < buf.length) {
      const streamStart = buf.indexOf('stream', pos);
      if (streamStart === -1) break;

      let dataStart = streamStart + 6;
      if (buf[dataStart] === 0x0D && buf[dataStart + 1] === 0x0A) dataStart += 2;
      else if (buf[dataStart] === 0x0A || buf[dataStart] === 0x0D) dataStart += 1;

      const streamEnd = buf.indexOf('endstream', dataStart);
      if (streamEnd === -1) break;

      const rawStream = buf.subarray(dataStart, streamEnd);
      // Check header before "stream" to see if it's an image XObject
      const headerSlice = buf.subarray(Math.max(0, streamStart - 200), streamStart).toString('latin1');
      if (!/\/Subtype\s*\/Image/i.test(headerSlice)) {
        let contentStr = '';
        if (/\/FlateDecode/i.test(headerSlice)) {
          try {
            contentStr = zlib.inflateSync(rawStream).toString('latin1');
          } catch (e) {
            try {
              contentStr = zlib.inflateRawSync(rawStream).toString('latin1');
            } catch (e2) {
              contentStr = '';
            }
          }
        } else {
          contentStr = rawStream.toString('latin1');
        }

        if (contentStr && (contentStr.includes('Tj') || contentStr.includes('TJ'))) {
          chunks.push(this.parsePdfTextOperators(contentStr));
        }
      }

      pos = streamEnd + 9;
    }

    return chunks.join('\n').replace(/[ \t]+/g, ' ').trim();
  },

  parsePdfTextOperators(contentStr) {
    const lines = [];
    let currentLine = '';

    // Split roughly by text positioning / line operators
    const tokens = contentStr.match(/(\((?:\\.|[^\\()])*\)\s*Tj|\[(?:\\.|[^\]])*\]\s*TJ|\bT\*|\bTd\b|\bTD\b|\bET\b)/g) || [];
    for (const tok of tokens) {
      if (tok === 'T*' || tok === 'Td' || tok === 'TD' || tok === 'ET') {
        if (currentLine.trim()) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
      } else if (tok.endsWith('Tj')) {
        const m = tok.match(/^\((.*)\)\s*Tj$/s);
        if (m) currentLine += this.unescapePdfString(m[1]) + ' ';
      } else if (tok.endsWith('TJ')) {
        const parts = tok.match(/\((?:\\.|[^\\()])*\)|-?\d+(?:\.\d+)?/g) || [];
        let joined = '';
        for (const p of parts) {
          if (p.startsWith('(')) {
            joined += this.unescapePdfString(p.slice(1, -1));
          } else if (parseFloat(p) <= -120 && joined && !joined.endsWith(' ')) {
            joined += ' ';
          }
        }
        currentLine += joined + ' ';
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    return lines.join('\n');
  },

  unescapePdfString(str) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }
};

module.exports = PdfService;
