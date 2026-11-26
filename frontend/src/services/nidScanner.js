/**
 * Client-Side Bangladeshi NID Card Scanner Engine:
 * 5x5 Gaussian Smoothing -> Sobel + Canny NMS Edge Ridges -> Hysteresis Thresholding ->
 * Dual Contour (approxPolyDP) + All-Pairs Orthogonal Hough Quad Scoring ->
 * Sub-Pixel Line Regression -> Bilinear 4-Point Projective Homography ->
 * Residual Border Guard & 300 DPI Print-Ready Flatbed A4 Generator.
 */

export const CR80_WIDTH_MM = 85.6;
export const CR80_HEIGHT_MM = 53.98;
export const NID_CANVAS_W = 1012; // 300 DPI for 85.6mm
export const NID_CANVAS_H = 638;  // 300 DPI for 53.98mm
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;
export const A4_CANVAS_W = 2480;  // 300 DPI A4 width
export const A4_CANVAS_H = 3508;  // 300 DPI A4 height

const CARD_ASPECT = CR80_WIDTH_MM / CR80_HEIGHT_MM; // ~1.5858

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Automatically detects whether an image/canvas is a Bangladesh Smart NID Card (polycarbonate IC chip card
 * with mint/teal/lime-green security guilloche mesh and no printed black border frame) vs. a Laminated Paper NID Card.
 */
export function isSmartNidCardImageData(data, width, height) {
  const x0 = Math.floor(width * 0.15), x1 = Math.floor(width * 0.85);
  const y0 = Math.floor(height * 0.20), y1 = Math.floor(height * 0.80);
  const stepX = Math.max(2, Math.floor((x1 - x0) / 70));
  const stepY = Math.max(2, Math.floor((y1 - y0) / 50));
  let greenGuilloche = 0, totalBright = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum >= 128) {
        totalBright++;
        if (g - r >= 5 && g >= b - 8) greenGuilloche++;
      }
    }
  }
  return totalBright > 0 && (greenGuilloche / totalBright) >= 0.09;
}

/**
 * Loads an image File/Blob cleanly with EXIF orientation support and returns a bounded source canvas.
 */
export async function loadOrientedImageCanvas(fileOrUrl, maxSourceDim = 2200) {
  let width = 0;
  let height = 0;
  let drawable = null;
  let revokeUrl = '';

  try {
    if (typeof createImageBitmap === 'function' && fileOrUrl instanceof Blob) {
      const bitmap = await createImageBitmap(fileOrUrl, { imageOrientation: 'from-image' }).catch(() => null);
      if (bitmap) {
        drawable = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      }
    }

    if (!drawable) {
      const srcUrl = typeof fileOrUrl === 'string' ? fileOrUrl : (revokeUrl = URL.createObjectURL(fileOrUrl));
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not decode image file.'));
        el.src = srcUrl;
      });
      drawable = img;
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
    }

    const scale = Math.min(1, maxSourceDim / Math.max(width || 1, height || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);

    if (typeof drawable.close === 'function') drawable.close();
    return canvas;
  } finally {
    if (revokeUrl) URL.revokeObjectURL(revokeUrl);
  }
}

/**
 * Rotates a canvas by multiples of 90 degrees clockwise.
 */
export function rotateCanvas90(sourceCanvas, steps = 1) {
  const s = ((steps % 4) + 4) % 4;
  if (s === 0) return sourceCanvas;
  const out = document.createElement('canvas');
  out.width = s % 2 === 1 ? sourceCanvas.height : sourceCanvas.width;
  out.height = s % 2 === 1 ? sourceCanvas.width : sourceCanvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((s * Math.PI) / 2);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return out;
}

/**
 * Orders 4 polygon vertices clockwise starting from Top-Left: [TL, TR, BR, BL].
 */
export function orderQuadCorners(pts) {
  if (!pts || pts.length !== 4) return pts;
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4;
  const cy = pts.reduce((a, p) => a + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let tlIdx = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[tlIdx].x + sorted[tlIdx].y) tlIdx = i;
  }
  return [sorted[tlIdx], sorted[(tlIdx + 1) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 3) % 4]];
}

function quadArea(pts) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function isConvexQuad(pts) {
  if (!pts || pts.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

function rdpPolygon(points, epsilon) {
  if (points.length <= 4) return points;
  const pointLineDist = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return dist2(p, a);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
  };
  let maxDist = 0;
  let idx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = pointLineDist(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdpPolygon(points.slice(0, idx + 1), epsilon);
    const right = rdpPolygon(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

/**
 * Pure-JS computer vision detector: locates exact 4 NID card corners [TL, TR, BR, BL] normalized in [0..1].
 * Uses 5x5 Gaussian blur -> Sobel + Canny Non-Maximum Suppression -> Hysteresis ->
 * Contour approxPolyDP & All-Pairs Gradient Hough with sub-pixel RANSAC/least-squares line refit.
 */
export function detectCardCornersFromImageData(data, width, height) {
  const N = width * height;
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  // 1. Separable 5x5 Gaussian smoothing ([1, 4, 6, 4, 1] / 16)
  const tmpBlur = new Float32Array(N);
  const blur = new Float32Array(N);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const xm2 = clamp(x - 2, 0, width - 1);
      const xm1 = clamp(x - 1, 0, width - 1);
      const xp1 = clamp(x + 1, 0, width - 1);
      const xp2 = clamp(x + 2, 0, width - 1);
      tmpBlur[row + x] = (gray[row + xm2] + 4 * gray[row + xm1] + 6 * gray[row + x] + 4 * gray[row + xp1] + gray[row + xp2]) / 16;
    }
  }
  for (let y = 0; y < height; y++) {
    const ym2 = clamp(y - 2, 0, height - 1) * width;
    const ym1 = clamp(y - 1, 0, height - 1) * width;
    const y0 = y * width;
    const yp1 = clamp(y + 1, 0, height - 1) * width;
    const yp2 = clamp(y + 2, 0, height - 1) * width;
    for (let x = 0; x < width; x++) {
      blur[y0 + x] = (tmpBlur[ym2 + x] + 4 * tmpBlur[ym1 + x] + 6 * tmpBlur[y0 + x] + 4 * tmpBlur[yp1 + x] + tmpBlur[yp2 + x]) / 16;
    }
  }

  // 2. Sobel gradient (gx, gy, mag)
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  const mag = new Float32Array(N);
  const hist = new Uint32Array(256);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = (
        -blur[i - width - 1] + blur[i - width + 1] +
        -2 * blur[i - 1] + 2 * blur[i + 1] +
        -blur[i + width - 1] + blur[i + width + 1]
      );
      const dy = (
        -blur[i - width - 1] - 2 * blur[i - width] - blur[i - width + 1] +
        blur[i + width - 1] + 2 * blur[i + width] + blur[i + width + 1]
      );
      const m = Math.hypot(dx, dy);
      gx[i] = dx;
      gy[i] = dy;
      mag[i] = m;
      hist[Math.min(255, Math.floor(m))]++;
    }
  }

  // Adaptive Canny double threshold via gradient percentile (~88th pct high)
  let totalGrad = 0;
  for (let b = 1; b < 256; b++) totalGrad += hist[b];
  let cum = 0;
  let highThresh = 42;
  const targetRank = Math.floor(totalGrad * 0.88);
  for (let b = 1; b < 256; b++) {
    cum += hist[b];
    if (cum >= targetRank) {
      highThresh = Math.max(22, b);
      break;
    }
  }
  const lowThresh = Math.max(10, highThresh * 0.42);

  // 3. Canny Non-Maximum Suppression (1px sharp edge ridges)
  const nms = new Float32Array(N);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      const m = mag[i];
      if (m < lowThresh) continue;
      let ang = (Math.atan2(gy[i], gx[i]) * 180) / Math.PI;
      if (ang < 0) ang += 180;
      let m1 = 0, m2 = 0;
      if (ang < 22.5 || ang >= 157.5) {
        m1 = mag[i - 1]; m2 = mag[i + 1];
      } else if (ang < 67.5) {
        m1 = mag[i - width + 1]; m2 = mag[i + width - 1];
      } else if (ang < 112.5) {
        m1 = mag[i - width]; m2 = mag[i + width];
      } else {
        m1 = mag[i - width - 1]; m2 = mag[i + width + 1];
      }
      if (m >= m1 && m >= m2) nms[i] = m;
    }
  }

  // 4. Hysteresis Edge Linking
  const edges = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      if (nms[i] >= highThresh && !edges[i]) {
        edges[i] = 1;
        stack[sp++] = i;
      }
    }
  }
  while (sp > 0) {
    const cur = stack[--sp];
    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx > 1 && nx < width - 2 && ny > 1 && ny < height - 2) {
          const nb = ny * width + nx;
          if (!edges[nb] && nms[nb] >= lowThresh) {
            edges[nb] = 1;
            stack[sp++] = nb;
          }
        }
      }
    }
  }

  // Score a 4-point quad strictly:
  // Rewards oriented Canny edge ridges on all 4 sides + bright clean card inside perimeter + distinct exterior vs interior
  const evaluateCandidate = (rawPts) => {
    if (!rawPts || rawPts.length !== 4) return null;
    // Allow off-frame projective corners up to 22% outside the frame for close-up tilted shots
    const pts = orderQuadCorners(rawPts.map(p => ({
      x: clamp(p.x, -width * 0.22, width * 1.22),
      y: clamp(p.y, -height * 0.22, height * 1.22)
    })));
    if (!isConvexQuad(pts)) return null;

    const area = quadArea(pts);
    const areaRatio = area / N;
    if (areaRatio < 0.05 || areaRatio > 1.12) return null;

    const wTop = dist2(pts[0], pts[1]);
    const wBot = dist2(pts[3], pts[2]);
    const hLeft = dist2(pts[0], pts[3]);
    const hRight = dist2(pts[1], pts[2]);
    const avgW = (wTop + wBot) / 2;
    const avgH = (hLeft + hRight) / 2;
    if (avgW < 30 || avgH < 30) return null;

    if (width > height * 1.10 && avgW < avgH * 1.10) return null;
    const ratio = Math.max(avgW, avgH) / Math.max(1, Math.min(avgW, avgH));
    if (ratio < 1.15 || ratio > 2.25) return null;

    const wRatio = Math.min(wTop, wBot) / Math.max(1, Math.max(wTop, wBot));
    const hRatio = Math.min(hLeft, hRight) / Math.max(1, Math.max(hLeft, hRight));
    if (wRatio < 0.44 || hRatio < 0.44) return null;

    for (let i = 0; i < 4; i++) {
      const prev = pts[(i + 3) % 4];
      const cur = pts[i];
      const next = pts[(i + 1) % 4];
      const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
      const v2x = next.x - cur.x, v2y = next.y - cur.y;
      const cosAng = (v1x * v2x + v1y * v2y) / (Math.max(1, Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)));
      if (Math.abs(cosAng) > 0.58) return null;
    }

    const qcx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const qcy = pts.reduce((s, p) => s + p.y, 0) / 4;

    let orientedHits = 0;
    let totalSamples = 0;
    let insideCleanCount = 0;
    let boundaryDiffSum = 0;
    let boundaryPairs = 0;
    let internalClipSides = 0;
    let blackBorderHits = 0;

    for (let s = 0; s < 4; s++) {
      const a = pts[s];
      const b = pts[(s + 1) % 4];
      const elen = dist2(a, b);
      const ux = (b.x - a.x) / elen;
      const uy = (b.y - a.y) / elen;
      let nx = -uy;
      let ny = ux;
      if ((qcx - (a.x + b.x) / 2) * nx + (qcy - (a.y + b.y) / 2) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }

      const steps = 28;
      let extPaperHits = 0;
      let extInkOrBorderHits = 0;
      let sideSamples = 0;
      for (let k = 2; k <= steps - 2; k++) {
        const px = a.x + (b.x - a.x) * (k / steps);
        const py = a.y + (b.y - a.y) * (k / steps);

        // If this point on the edge lies along or outside the camera frame boundary, check if interior is white card
        if (px < 3 || px >= width - 3 || py < 3 || py >= height - 3) {
          const ixB = clamp(Math.round(px + nx * 8), 0, width - 1);
          const iyB = clamp(Math.round(py + ny * 8), 0, height - 1);
          const inB = (iyB * width + ixB) * 4;
          const lumB = 0.299 * data[inB] + 0.587 * data[inB + 1] + 0.114 * data[inB + 2];
          if (lumB >= 175) {
            orientedHits += 0.72;
            insideCleanCount++;
          }
          totalSamples++;
          boundaryPairs++;
          continue;
        }

        let bestAlign = 0;
        let hasDarkStroke = false;
        for (let d = -2.5; d <= 2.5; d += 0.5) {
          const sx = clamp(Math.round(px + nx * d), 1, width - 2);
          const sy = clamp(Math.round(py + ny * d), 1, height - 2);
          const idx = sy * width + sx;
          if (gray[idx] < 135) hasDarkStroke = true;
          if (edges[idx] || mag[idx] >= lowThresh * 1.15) {
            const align = Math.abs(gx[idx] * nx + gy[idx] * ny) / Math.max(1, mag[idx]);
            if (align > bestAlign) bestAlign = align;
          }
        }
        if (bestAlign >= 0.70) orientedHits++;
        totalSamples++;
        sideSamples++;

        const ix = clamp(Math.round(px + nx * 4.5), 0, width - 1);
        const iy = clamp(Math.round(py + ny * 4.5), 0, height - 1);
        const ox = clamp(Math.round(px - nx * 4.5), 0, width - 1);
        const oy = clamp(Math.round(py - ny * 4.5), 0, height - 1);
        const inIdx = (iy * width + ix) * 4;
        const outIdx = (oy * width + ox) * 4;
        const inR = data[inIdx], inG = data[inIdx + 1], inB = data[inIdx + 2];
        const inLum = 0.299 * inR + 0.587 * inG + 0.114 * inB;
        const inSat = Math.max(inR, inG, inB) - Math.min(inR, inG, inB);
        if (inLum > 165) insideCleanCount++;
        if (hasDarkStroke && inLum >= 185 && inSat < 38) blackBorderHits++;

        const colDiff = Math.hypot(inR - data[outIdx], inG - data[outIdx + 1], inB - data[outIdx + 2]);
        boundaryDiffSum += colDiff;
        boundaryPairs++;

        // Check 10..60 px OUTSIDE this edge: if bright white card paper exists outside this edge,
        // this edge is an internal divider/barcode/text line cutting through the card interior!
        let hasExtPaper = false;
        let hasExtInk = false;
        for (const od of [10, 18, 28, 42, 56]) {
          const ex = Math.round(px - nx * od);
          const ey = Math.round(py - ny * od);
          if (ex < 2 || ex >= width - 2 || ey < 2 || ey >= height - 2) continue;
          const eIdx = (ey * width + ex) * 4;
          const eR = data[eIdx], eG = data[eIdx + 1], eB = data[eIdx + 2];
          const eLum = 0.299 * eR + 0.587 * eG + 0.114 * eB;
          const eSat = Math.max(eR, eG, eB) - Math.min(eR, eG, eB);
          if (eLum >= 190 && eSat < 35) hasExtPaper = true;
          if (eLum < 95 && eSat < 45) hasExtInk = true;
        }
        if (hasExtPaper) extPaperHits++;
        if (hasExtInk) extInkOrBorderHits++;
      }
      if (sideSamples > 0 && extPaperHits / sideSamples >= 0.42 && extInkOrBorderHits / sideSamples >= 0.08) {
        internalClipSides++;
      }
    }

    const edgeScore = orientedHits / Math.max(1, totalSamples);
    const insideBrightRatio = insideCleanCount / Math.max(1, boundaryPairs);
    const blackBorderRatio = blackBorderHits / Math.max(1, totalSamples);
    const meanBoundaryContrast = Math.min(1, (boundaryDiffSum / Math.max(1, boundaryPairs)) / 55);
    const ratioFit = Math.exp(-Math.pow((ratio - CARD_ASPECT) / 0.42, 2));
    const areaFit = areaRatio >= 0.14 && areaRatio <= 1.08 ? 1.0 : 0.78;
    const sizeCoverage = Math.min(1, Math.sqrt(areaRatio / 0.48));
    const clipPenalty = internalClipSides * 0.34;
    const score =
      edgeScore * 0.40 +
      blackBorderRatio * 0.16 +
      ratioFit * 0.18 +
      insideBrightRatio * 0.12 +
      meanBoundaryContrast * 0.07 +
      sizeCoverage * 0.07 -
      clipPenalty;
    return { pts, score: score * areaFit, edgeScore, areaRatio };
  };

  // Sub-pixel RANSAC + weighted least-squares line refit strictly preferring printed black card borders over outer lamination
  const refitEdgesExact = (pts) => {
    const qcx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const qcy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const lines = [];

    for (let s = 0; s < 4; s++) {
      const a = pts[s];
      const b = pts[(s + 1) % 4];
      const elen = dist2(a, b);
      if (elen < 24) return pts;
      const ux = (b.x - a.x) / elen;
      const uy = (b.y - a.y) / elen;
      let nx = -uy;
      let ny = ux;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if ((qcx - midX) * nx + (qcy - midY) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }

      const samples = [];
      for (let step = 0; step < 30; step++) {
        const t = 0.08 + (step / 29) * 0.84;
        const bx = a.x + (b.x - a.x) * t;
        const by = a.y + (b.y - a.y) * t;
        let bestSc = 0;
        let bestD = 0;
        let bestX = bx;
        let bestY = by;
        let bestIsBlackInner = false;

        for (let d = -18; d <= 32; d += 0.5) {
          const sx = Math.round(bx + nx * d);
          const sy = Math.round(by + ny * d);
          if (sx < 2 || sx >= width - 2 || sy < 2 || sy >= height - 2) continue;
          const idx = sy * width + sx;
          if (!edges[idx] && mag[idx] < lowThresh * 1.15) continue;
          const align = Math.abs(gx[idx] * nx + gy[idx] * ny) / Math.max(1, mag[idx]);
          if (align < 0.72) continue;
          const ix = clamp(Math.round(bx + nx * (d + 3.5)), 0, width - 1);
          const iy = clamp(Math.round(by + ny * (d + 3.5)), 0, height - 1);
          const iOff = (iy * width + ix) * 4;
          const inR = data[iOff], inG = data[iOff + 1], inB = data[iOff + 2];
          const inLum = 0.299 * inR + 0.587 * inG + 0.114 * inB;
          const inSat = Math.max(inR, inG, inB) - Math.min(inR, inG, inB);

          let minOutLum = 255;
          let minOutSat = 255;
          for (const os of [0.0, 1.0, 1.5, 2.0, 2.5, 3.0]) {
            const ox = clamp(Math.round(bx + nx * (d - os)), 0, width - 1);
            const oy = clamp(Math.round(by + ny * (d - os)), 0, height - 1);
            const oOff = (oy * width + ox) * 4;
            const outR = data[oOff], outG = data[oOff + 1], outB = data[oOff + 2];
            const oLum = 0.299 * outR + 0.587 * outG + 0.114 * outB;
            if (oLum < minOutLum) {
              minOutLum = oLum;
              minOutSat = Math.max(outR, outG, outB) - Math.min(outR, outG, outB);
            }
          }

          const isBlackBorder = minOutLum < 130 && minOutSat < 42 && inLum >= 185 && inSat < 38;
          const cardInsideBonus = isBlackBorder ? 2.6 : (inLum >= 188 && inSat < 35 ? 1.45 : (inLum >= 145 ? 0.9 : 0.55));
          const sc = (edges[idx] ? 1.5 : 1.0) * align * mag[idx] * cardInsideBonus * (1 - Math.abs(d) * 0.008);
          if (sc > bestSc) {
            bestSc = sc;
            bestD = d;
            bestX = bx + nx * d;
            bestY = by + ny * d;
            bestIsBlackInner = isBlackBorder;
          }
        }
        if (bestSc > 0) samples.push({ x: bestX, y: bestY, d: bestD, t, w: bestSc, isBlackInner: bestIsBlackInner });
      }

      if (samples.length < 8) {
        lines.push({ a: nx, b: ny, c: nx * midX + ny * midY });
        continue;
      }
      const leftD = samples.filter(v => v.t < 0.45).map(v => v.d).sort((x, y) => x - y);
      const rightD = samples.filter(v => v.t >= 0.55).map(v => v.d).sort((x, y) => x - y);
      const dSorted = samples.map(v => v.d).sort((x, y) => x - y);
      const dMed = dSorted[Math.floor(dSorted.length / 2)];
      const dL = leftD.length >= 2 ? leftD[Math.floor(leftD.length / 2)] : dMed;
      const dR = rightD.length >= 2 ? rightD[Math.floor(rightD.length / 2)] : dMed;
      const trendSlope = (dR - dL) / 0.50;
      const trendMid = 0.5 * (dL + dR);
      const inliers = samples.filter(v => Math.abs(v.d - (trendMid + trendSlope * (v.t - 0.5))) <= 2.8);
      if (inliers.length < 6) {
        lines.push({ a: nx, b: ny, c: nx * midX + ny * midY });
        continue;
      }

      let sumW = 0, sumU = 0, sumV = 0, sumUU = 0, sumUV = 0, blackInnerVotes = 0;
      for (const p of inliers) {
        const rx = p.x - midX;
        const ry = p.y - midY;
        const u = rx * ux + ry * uy;
        const v = rx * nx + ry * ny;
        sumW += p.w;
        sumU += p.w * u;
        sumV += p.w * v;
        sumUU += p.w * u * u;
        sumUV += p.w * u * v;
        if (p.isBlackInner) blackInnerVotes++;
      }
      const meanU = sumU / sumW;
      const meanV = sumV / sumW;
      const denom = sumUU - sumW * meanU * meanU;
      const slope = Math.abs(denom) > 1e-4 ? clamp((sumUV - sumW * meanU * meanV) / denom, -0.28, 0.28) : 0;

      const snapOffset = blackInnerVotes >= inliers.length * 0.35 ? -2.5 : 1.25;
      const intercept = meanV - slope * meanU + snapOffset;
      const lineNx = nx - slope * ux;
      const lineNy = ny - slope * uy;
      const pLineX = midX + nx * intercept;
      const pLineY = midY + ny * intercept;
      lines.push({ a: lineNx, b: lineNy, c: lineNx * pLineX + lineNy * pLineY });
    }

    const intersect = (l1, l2) => {
      const det = l1.a * l2.b - l1.b * l2.a;
      if (Math.abs(det) < 1e-5) return null;
      return {
        x: clamp((l1.c * l2.b - l1.b * l2.c) / det, -width * 0.22, width * 1.22),
        y: clamp((l1.a * l2.c - l1.c * l2.a) / det, -height * 0.22, height * 1.22)
      };
    };

    const refit = [
      intersect(lines[3], lines[0]),
      intersect(lines[0], lines[1]),
      intersect(lines[1], lines[2]),
      intersect(lines[2], lines[3])
    ].filter(Boolean);

    if (refit.length === 4 && isConvexQuad(refit) && evaluateCandidate(refit)) {
      return orderQuadCorners(refit);
    }
    return pts;
  };

  const candidates = [];

  // Candidate Group A: Multi-Compartment White Card Union & 4-Side RANSAC Line Fitter + Background Diff
  try {
    const sampleIndices = [];
    const marginX = Math.max(2, Math.floor(width * 0.04));
    const marginY = Math.max(2, Math.floor(height * 0.04));
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (x < marginX || x >= width - marginX || y < marginY || y >= height - marginY) {
          sampleIndices.push(y * width + x);
        }
      }
    }
    const rArr = sampleIndices.map(i => data[i * 4]).sort((a, b) => a - b);
    const gArr = sampleIndices.map(i => data[i * 4 + 1]).sort((a, b) => a - b);
    const bArr = sampleIndices.map(i => data[i * 4 + 2]).sort((a, b) => a - b);
    const mid = Math.floor(sampleIndices.length / 2);
    const bgR = rArr[mid] || 0;
    const bgG = gArr[mid] || 0;
    const bgB = bArr[mid] || 0;

    const diff = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const idx = i * 4;
      diff[i] = Math.hypot(data[idx] - bgR, data[idx + 1] - bgG, data[idx + 2] - bgB);
    }
    const borderDists = sampleIndices.map(i => diff[i]).sort((a, b) => a - b);
    const fgThresh = clamp((borderDists[Math.floor(borderDists.length * 0.85)] || 18) * 1.45, 24, 72);

    // Sub-module A1: Universal 2-Stage Local-Illumination White Paper Slab + 5-Pixel Tangent-Minimum Printed Border Tracker
    // Stage 1: Build an 8x8 local illumination grid of low-saturation brightness so strong left-to-right outdoor
    //          shade/sunlight gradients (e.g. shaded left paper lum=155 vs sunlit right lamination lum=170) are
    //          normalized locally. Close 1..2px border/divider strokes morphologically to extract the full White
    //          Paper Card Slab [sT, sB, sL, sR] while rejecting 100% of plastic lamination pouches, stools, and desks.
    // Stage 2: Scan inward from each of the 4 outer paper slab lines using a 5-pixel tangent minimum tMin[d] (which
    //          turns 2008-generation dotted/dash-dot borders "-..-..-.." into continuous dark troughs identical to
    //          2016-2026 solid black borders!) and lock onto the FIRST dark stroke sandwiched between the outer white
    //          paper margin (outerBright >= innerBright - 26) and the inner white card interior (innerContrast >= 22).
    const satArr = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const idx = i * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      satArr[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }

    const gW = 8, gH = 8;
    const cellRef = new Float32Array(gW * gH);
    const cW = width / gW, cH = height / gH;
    const allLowSat = [];
    for (let gy = 0; gy < gH; gy++) {
      const y0 = Math.floor(gy * cH), y1 = Math.min(height, Math.ceil((gy + 1) * cH));
      for (let gx = 0; gx < gW; gx++) {
        const x0 = Math.floor(gx * cW), x1 = Math.min(width, Math.ceil((gx + 1) * cW));
        const vals = [];
        for (let y = y0; y < y1; y += 3) {
          for (let x = x0; x < x1; x += 3) {
            const i = y * width + x;
            if (satArr[i] <= 32 && gray[i] >= 125) {
              vals.push(gray[i]);
              if (gx >= 1 && gx <= 6 && gy >= 2 && gy <= 5) allLowSat.push(gray[i]);
            }
          }
        }
        vals.sort((a, b) => a - b);
        cellRef[gy * gW + gx] = vals.length >= 8 ? vals[Math.floor(vals.length * 0.82)] : 0;
      }
    }
    allLowSat.sort((a, b) => a - b);
    const globalPaperRef = allLowSat.length ? allLowSat[Math.floor(allLowSat.length * 0.78)] : 200;
    for (let k = 0; k < gW * gH; k++) {
      if (cellRef[k] < globalPaperRef * 0.78) cellRef[k] = globalPaperRef * 0.86;
    }
    const smoothRef = new Float32Array(gW * gH);
    for (let gy = 0; gy < gH; gy++) {
      for (let gx = 0; gx < gW; gx++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = clamp(gy + dy, 0, gH - 1), nx = clamp(gx + dx, 0, gW - 1);
            s += cellRef[ny * gW + nx];
            c++;
          }
        }
        smoothRef[gy * gW + gx] = s / c;
      }
    }

    const isSmartCard = isSmartNidCardImageData(data, width, height);

    const rawPaper = new Uint8Array(N);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      const gy = clamp(Math.floor(y / cH), 0, gH - 1) * gW;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        const g = gray[i];
        const s = satArr[i];
        const locRef = smoothRef[gy + clamp(Math.floor(x / cW), 0, gW - 1)];
        const locFloor = clamp(locRef * 0.80, 138, 186);
        if (g >= locFloor && s <= 30 && (g - s * 1.5 >= locFloor - 16)) {
          rawPaper[i] = 1;
        } else if (isSmartCard && g >= locFloor) {
          const idx = i * 4;
          const rCh = data[idx], gCh = data[idx + 1];
          // Include Smart Card mint/teal/lime-green security guilloche bands and bright pastel flag guilloche
          if ((gCh >= rCh - 8 && s <= 65) || (g >= locFloor + 12 && s <= 54)) {
            rawPaper[i] = 1;
          }
        }
      }
    }

    const dilPaper = new Uint8Array(N);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        if (rawPaper[i] || rawPaper[i - 1] || rawPaper[i + 1] || rawPaper[i - width] || rawPaper[i + width]) {
          dilPaper[i] = 1;
        }
      }
    }
    const closedPaper = new Uint8Array(N);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        if (dilPaper[i] && dilPaper[i - 1] && dilPaper[i + 1] && dilPaper[i - width] && dilPaper[i + width]) {
          closedPaper[i] = 1;
        }
      }
    }

    const queue = new Int32Array(N);
    const compVis = new Uint8Array(N);
    const unionWhite = new Uint8Array(N);
    let totalUnionPixels = 0;
    let uMinX = width, uMaxX = 0, uMinY = height, uMaxY = 0;
    const minCompPixels = Math.floor(N * 0.008);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const start = y * width + x;
        if (!closedPaper[start] || compVis[start]) continue;
        let head = 0, tail = 0;
        compVis[start] = 1;
        queue[tail++] = start;
        let minX = x, maxX = x, minY = y, maxY = y;
        let sumX = 0, sumY = 0;
        while (head < tail) {
          const cur = queue[head++];
          const cx = cur % width;
          const cy = (cur - cx) / width;
          sumX += cx;
          sumY += cy;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          if (cx > 0 && closedPaper[cur - 1] && !compVis[cur - 1]) { compVis[cur - 1] = 1; queue[tail++] = cur - 1; }
          if (cx < width - 1 && closedPaper[cur + 1] && !compVis[cur + 1]) { compVis[cur + 1] = 1; queue[tail++] = cur + 1; }
          if (cy > 0 && closedPaper[cur - width] && !compVis[cur - width]) { compVis[cur - width] = 1; queue[tail++] = cur - width; }
          if (cy < height - 1 && closedPaper[cur + width] && !compVis[cur + width]) { compVis[cur + width] = 1; queue[tail++] = cur + width; }
        }
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const fill = tail / Math.max(1, bw * bh);
        const spanW = bw / width;
        const spanH = bh / height;
        const meanX = (sumX / tail) / width;
        const meanY = (sumY / tail) / height;
        const majorSpan = Math.max(spanW, spanH);
        if (tail >= minCompPixels && fill >= 0.25 && majorSpan >= 0.32 && meanX >= 0.18 && meanX <= 0.82 && meanY >= 0.18 && meanY <= 0.82) {
          for (let k = 0; k < tail; k++) unionWhite[queue[k]] = 1;
          totalUnionPixels += tail;
          if (minX < uMinX) uMinX = minX;
          if (maxX > uMaxX) uMaxX = maxX;
          if (minY < uMinY) uMinY = minY;
          if (maxY > uMaxY) uMaxY = maxY;
        }
      }
    }

    if (totalUnionPixels >= N * 0.04 && uMaxX > uMinX + 40 && uMaxY > uMinY + 40) {
      const topPts = [], botPts = [], leftPts = [], rightPts = [];
      const uW = uMaxX - uMinX + 1;
      const uH = uMaxY - uMinY + 1;
      for (let x = uMinX + Math.floor(uW * 0.06); x <= uMaxX - Math.floor(uW * 0.06); x++) {
        let firstY = -1, lastY = -1;
        for (let y = uMinY; y <= uMaxY; y++) {
          if (unionWhite[y * width + x]) {
            if (firstY < 0) firstY = y;
            lastY = y;
          }
        }
        if (firstY >= 0 && firstY <= uMinY + Math.floor(uH * 0.15)) topPts.push({ u: x, v: firstY });
        if (lastY >= uMaxY - Math.floor(uH * 0.15) && lastY <= height - 2) botPts.push({ u: x, v: lastY });
      }
      for (let y = uMinY + Math.floor(uH * 0.06); y <= uMaxY - Math.floor(uH * 0.06); y++) {
        let firstX = -1, lastX = -1;
        const row = y * width;
        for (let x = uMinX; x <= uMaxX; x++) {
          if (unionWhite[row + x]) {
            if (firstX < 0) firstX = x;
            lastX = x;
          }
        }
        if (firstX >= 0 && firstX <= uMinX + Math.floor(uW * 0.15)) leftPts.push({ u: y, v: firstX });
        if (lastX >= uMaxX - Math.floor(uW * 0.15) && lastX <= width - 2) rightPts.push({ u: y, v: lastX });
      }

      const fitRansac1D = (pts, maxSlope = 0.42) => {
        if (pts.length < 8) return null;
        let bestScore = -1;
        let bestM = 0, bestB = 0;
        const step = Math.max(1, Math.floor(pts.length / 30));
        for (let i = 0; i < pts.length; i += step) {
          for (let j = i + step; j < pts.length; j += step) {
            const du = pts[j].u - pts[i].u;
            if (Math.abs(du) < 20) continue;
            const m = (pts[j].v - pts[i].v) / du;
            if (Math.abs(m) > maxSlope) continue;
            const b = pts[i].v - m * pts[i].u;
            let sc = 0;
            for (let k = 0; k < pts.length; k++) {
              const err = Math.abs(pts[k].v - (m * pts[k].u + b));
              if (err <= 2.8) sc += (1 - err / 3.5);
            }
            if (sc > bestScore) {
              bestScore = sc;
              bestM = m;
              bestB = b;
            }
          }
        }
        if (bestScore < 5) return null;
        return { m: bestM, b: bestB, score: bestScore };
      };

      const sT = fitRansac1D(topPts);
      const sB = fitRansac1D(botPts);
      const sL = fitRansac1D(leftPts);
      const sR = fitRansac1D(rightPts);

      const getGray = (x, y) => gray[clamp(Math.round(y), 0, height - 1) * width + clamp(Math.round(x), 0, width - 1)];

      const findPrintedBorderLine = (side, slabLine) => {
        if (!slabLine) return null;
        const isHoriz = side === 'top' || side === 'bottom';
        const dir = (side === 'top' || side === 'left') ? 1 : -1;
        const maxD = Math.floor((isHoriz ? uH : uW) * 0.085);
        const uStart = isHoriz ? (uMinX + Math.floor(uW * 0.08)) : (uMinY + Math.floor(uH * 0.08));
        const uEnd = isHoriz ? (uMaxX - Math.floor(uW * 0.08)) : (uMaxY - Math.floor(uH * 0.08));
        const borderPts = [];

        for (let u = uStart; u <= uEnd; u += 3) {
          const baseV = slabLine.m * u + slabLine.b;
          const tMin = new Float32Array(maxD + 16);
          const tAvg = new Float32Array(maxD + 16);
          for (let d = 0; d < tMin.length; d++) {
            const v = baseV + dir * (d - 6);
            let mn = 255, sum = 0;
            for (let t = -2; t <= 2; t++) {
              const ut = u + t;
              const vt = v + slabLine.m * t;
              const val = isHoriz ? getGray(ut, vt) : getGray(vt, ut);
              if (val < mn) mn = val;
              sum += val;
            }
            tMin[d] = mn;
            tAvg[d] = sum / 5;
          }

          let bestD = -1;
          for (let d = 2; d <= maxD + 4; d++) {
            const mn = tMin[d];
            if (mn > 158) continue;
            if (mn > tMin[d - 1] && mn > tMin[d + 1]) continue;

            let outerBright = 0;
            for (let k = Math.max(0, d - 5); k <= d - 1; k++) {
              if (tAvg[k] > outerBright) outerBright = tAvg[k];
            }
            let innerBright = 0;
            let innerCleanCount = 0;
            for (let k = 2; k <= 6 && d + k < tAvg.length; k++) {
              if (tAvg[d + k] > innerBright) innerBright = tAvg[d + k];
            }
            for (let k = 2; k <= 6 && d + k < tAvg.length; k++) {
              if (tAvg[d + k] >= innerBright - 18) innerCleanCount++;
            }

            const innerContrast = innerBright - mn;
            const outerContrast = outerBright - mn;
            if (
              innerBright >= 120 &&
              outerBright >= innerBright - 26 &&
              innerContrast >= 22 &&
              outerContrast >= 14 &&
              innerCleanCount >= 2
            ) {
              const snapD = (d + 1 <= maxD + 4 && tMin[d + 1] < mn) ? d + 1 : d;
              bestD = snapD - 6;
              break;
            }
          }

          if (bestD !== -1) {
            borderPts.push({ u, v: baseV + dir * bestD });
          }
        }

        return fitRansac1D(borderPts) || slabLine;
      };

      // Smart NID cards have no printed inner black border rectangle; their outer polycarbonate slab edge IS the card boundary!
      let lineT = isSmartCard ? sT : findPrintedBorderLine('top', sT);
      let lineB = isSmartCard ? sB : findPrintedBorderLine('bottom', sB);
      let lineL = isSmartCard ? sL : findPrintedBorderLine('left', sL);
      let lineR = isSmartCard ? sR : findPrintedBorderLine('right', sR);

      if (lineT && uMaxY >= height - 6) {
        const bVals = [];
        const effM = lineB ? 0.5 * (lineT.m + lineB.m) : lineT.m;
        for (let x = uMinX; x <= uMaxX; x += 2) {
          for (let y = height - 1; y >= Math.floor(height * 0.50); y--) {
            if (unionWhite[y * width + x]) {
              bVals.push((y + 2) - effM * x);
              break;
            }
          }
        }
        if (bVals.length >= 10) {
          bVals.sort((a, b) => a - b);
          const b95 = bVals[Math.floor(bVals.length * 0.95)];
          if (!lineB || (effM * width * 0.5 + b95) > (lineB.m * width * 0.5 + lineB.b)) {
            lineB = { m: effM, b: b95, score: 20 };
          }
        }
      }
      const hadAllFourLines = Boolean(lineT && lineB && lineL && lineR);
      if (!lineT) lineT = { m: 0, b: 2, score: 10 };
      if (!lineB) lineB = { m: 0, b: height - 3, score: 10 };
      if (!lineL) lineL = { m: 0, b: 2, score: 10 };
      if (!lineR) lineR = { m: 0, b: width - 3, score: 10 };

      const ixHV = (lH, lV, expandY, expandX) => {
        const bH = lH.b + expandY;
        const bV = lV.b + expandX;
        const denom = 1 - lV.m * lH.m;
        if (Math.abs(denom) < 1e-4) return null;
        const x = (lV.m * bH + bV) / denom;
        const y = lH.m * x + bH;
        return { x, y };
      };
      const quadUnion = [
        ixHV(lineT, lineL, 0.0, 0.0),
        ixHV(lineT, lineR, 0.0, 0.0),
        ixHV(lineB, lineR, 0.0, 0.0),
        ixHV(lineB, lineL, 0.0, 0.0)
      ].filter(Boolean);
      if (quadUnion.length === 4) {
        const candU = evaluateCandidate(quadUnion);
        if (candU) {
          candU.score += hadAllFourLines ? 1.50 : 0.35;
          candU.isExactInteriorUnion = hadAllFourLines;
          candidates.push(candU);
        }
      }
    }

    // Sub-module A2: Standard foreground difference masks for full-scene desk photos
    const maskPredicates = [
      (i) => {
        const idx = i * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        return lum >= 175 && sat < 65 && diff[i] > 12;
      },
      (i) => diff[i] > fgThresh || edges[i]
    ];

    for (const pred of maskPredicates) {
      const fg = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (pred(i)) fg[i] = 1;
      }

      const dil = new Uint8Array(N);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (fg[i] || fg[i - 1] || fg[i + 1] || fg[i - width] || fg[i + width]) dil[i] = 1;
        }
      }

      const extBg = new Uint8Array(N);
      let qHead = 0, qTail = 0;
      const pushBg = (idx) => {
        if (!dil[idx] && !extBg[idx]) {
          extBg[idx] = 1;
          queue[qTail++] = idx;
        }
      };
      for (let x = 0; x < width; x++) { pushBg(x); pushBg((height - 1) * width + x); }
      for (let y = 1; y < height - 1; y++) { pushBg(y * width); pushBg(y * width + width - 1); }
      while (qHead < qTail) {
        const cur = queue[qHead++];
        const cx = cur % width;
        const cy = (cur - cx) / width;
        if (cx > 0) pushBg(cur - 1);
        if (cx < width - 1) pushBg(cur + 1);
        if (cy > 0) pushBg(cur - width);
        if (cy < height - 1) pushBg(cur + width);
      }

      const solid = new Uint8Array(N);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (!extBg[i] && !extBg[i - 1] && !extBg[i + 1] && !extBg[i - width] && !extBg[i + width]) {
            solid[i] = 1;
          }
        }
      }

      const visited = new Uint8Array(N);
      let bestBoundary = null;
      let bestCount = 0;
      for (let y = marginY; y < height - marginY; y += 2) {
        for (let x = marginX; x < width - marginX; x += 2) {
          const start = y * width + x;
          if (!solid[start] || visited[start]) continue;
          let head = 0, tail = 0;
          visited[start] = 1;
          queue[tail++] = start;
          const boundary = [];
          while (head < tail) {
            const cur = queue[head++];
            const px = cur % width;
            const py = (cur - px) / width;
            let isEdge = px <= 1 || py <= 1 || px >= width - 2 || py >= height - 2;
            for (const nb of [cur - 1, cur + 1, cur - width, cur + width]) {
              if (nb < 0 || nb >= N || !solid[nb]) isEdge = true;
              else if (!visited[nb]) { visited[nb] = 1; queue[tail++] = nb; }
            }
            if (isEdge) boundary.push({ x: px, y: py });
          }
          if (tail > bestCount && tail < N * 0.94 && tail > N * 0.10) {
            bestCount = tail;
            bestBoundary = boundary;
          }
        }
      }

      if (bestBoundary && bestBoundary.length >= 20) {
        const sorted = [...bestBoundary].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
        const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
        const lower = [];
        for (const p of sorted) {
          while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
          lower.push(p);
        }
        const upper = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
          const p = sorted[i];
          while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
          upper.push(p);
        }
        const hull = lower.slice(0, -1).concat(upper.slice(0, -1));

        if (hull.length >= 4) {
          let peri = 0;
          for (let i = 0; i < hull.length; i++) peri += dist2(hull[i], hull[(i + 1) % hull.length]);
          for (const epsRatio of [0.02, 0.03, 0.045, 0.06]) {
            const closed = [...hull, hull[0]];
            const approx = rdpPolygon(closed, peri * epsRatio);
            if (approx.length === 5) {
              const c = evaluateCandidate(approx.slice(0, 4));
              if (c) candidates.push(c);
            }
          }
          const poly = [...hull];
          while (poly.length > 4) {
            let minArea = Infinity, minIdx = 0;
            for (let i = 0; i < poly.length; i++) {
              const prev = poly[(i - 1 + poly.length) % poly.length];
              const cur = poly[i];
              const next = poly[(i + 1) % poly.length];
              const tri = Math.abs((cur.x - prev.x) * (next.y - prev.y) - (cur.y - prev.y) * (next.x - prev.x));
              if (tri < minArea) { minArea = tri; minIdx = i; }
            }
            poly.splice(minIdx, 1);
          }
          const cPoly = evaluateCandidate(poly);
          if (cPoly) candidates.push(cPoly);
        }
      }
    }
  } catch {
    // continue to Hough candidate
  }

  // Candidate Group B: Black-Border Weighted Gradient Hough + 3-Side Aspect-Ratio Completion
  try {
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.ceil(Math.hypot(width, height));
    const rhoStep = 1.5;
    const numRho = Math.ceil((2 * maxR) / rhoStep) + 1;
    const numTheta = 180;
    const acc = new Float32Array(numTheta * numRho);
    const deg2rad = Math.PI / 180;

    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        const idx = y * width + x;
        if (!edges[idx]) continue;
        const m = mag[idx];
        // Boost Hough vote by 2.4x if this edge transitions between a dark neutral border stroke and bright white card paper
        const nx = gx[idx] / Math.max(1, m);
        const ny = gy[idx] / Math.max(1, m);
        const pInX = clamp(Math.round(x + nx * 3.5), 0, width - 1);
        const pInY = clamp(Math.round(y + ny * 3.5), 0, height - 1);
        const pOutX = clamp(Math.round(x - nx * 1.5), 0, width - 1);
        const pOutY = clamp(Math.round(y - ny * 1.5), 0, height - 1);
        const inI = (pInY * width + pInX) * 4;
        const outI = (pOutY * width + pOutX) * 4;
        const inLum = 0.299 * data[inI] + 0.587 * data[inI + 1] + 0.114 * data[inI + 2];
        const inSat = Math.max(data[inI], data[inI + 1], data[inI + 2]) - Math.min(data[inI], data[inI + 1], data[inI + 2]);
        const outLum = 0.299 * data[outI] + 0.587 * data[outI + 1] + 0.114 * data[outI + 2];
        const outSat = Math.max(data[outI], data[outI + 1], data[outI + 2]) - Math.min(data[outI], data[outI + 1], data[outI + 2]);
        const voteWeight = (inLum >= 188 && inSat < 38 && outLum < 130 && outSat < 42) ? m * 2.4 : m;

        let angDeg = (Math.atan2(gy[idx], gx[idx]) * 180) / Math.PI;
        if (angDeg < 0) angDeg += 180;
        if (angDeg >= 180) angDeg -= 180;
        const binCenter = Math.round(angDeg) % numTheta;
        for (let db = -1; db <= 1; db++) {
          const tb = (binCenter + db + numTheta) % numTheta;
          const th = tb * deg2rad;
          const rho = (x - cx) * Math.cos(th) + (y - cy) * Math.sin(th);
          const rb = Math.round((rho + maxR) / rhoStep);
          if (rb >= 0 && rb < numRho) acc[tb * numRho + rb] += voteWeight;
        }
      }
    }

    const oriScores = new Float32Array(90);
    for (let tb = 0; tb < numTheta; tb++) {
      let maxCol = 0;
      const base = tb * numRho;
      for (let rb = 0; rb < numRho; rb++) if (acc[base + rb] > maxCol) maxCol = acc[base + rb];
      oriScores[tb % 90] += maxCol;
    }

    const angleBins = [];
    for (let b = 0; b < 90; b++) angleBins.push({ b, sc: oriScores[b] });
    angleBins.sort((a, b) => b.sc - a.sc);
    const chosenAngles = [];
    for (const ab of angleBins) {
      if (!chosenAngles.some(ca => {
        const diff = Math.abs(ca - ab.b);
        return Math.min(diff, 90 - diff) < 12;
      })) {
        chosenAngles.push(ab.b);
        if (chosenAngles.length >= 2) break;
      }
    }

    const collectTopLines = (targetBin) => {
      const peaks = [];
      for (let dt = -15; dt <= 15; dt++) {
        const rawBin = targetBin + dt;
        const tb = ((rawBin % numTheta) + numTheta) % numTheta;
        const signFlip = rawBin < 0 || rawBin >= numTheta ? -1 : 1;
        const th = rawBin * deg2rad;
        const base = tb * numRho;
        for (let rb = 1; rb < numRho - 1; rb++) {
          const v = acc[base + rb];
          if (v > acc[base + rb - 1] && v >= acc[base + rb + 1] && v > 0) {
            const rawRho = rb * rhoStep - maxR;
            peaks.push({ th, rho: rawRho * signFlip, v });
          }
        }
      }
      peaks.sort((a, b) => b.v - a.v);
      const minSep = Math.min(width, height) * 0.04;
      const selected = [];
      // Collect top peaks separately across negative-rho and positive-rho half-planes so internal lines cannot crowd out outer borders
      const negSelected = [];
      const posSelected = [];
      for (const p of peaks) {
        const list = p.rho < 0 ? negSelected : posSelected;
        if (list.length < 5 && !list.some(s => Math.abs(s.rho - p.rho) < minSep && Math.abs(s.th - p.th) < 0.10)) {
          list.push(p);
          selected.push(p);
        }
        if (negSelected.length >= 5 && posSelected.length >= 5) break;
      }
      return selected;
    };

    const intersect = (l1, l2) => {
      const c1 = Math.cos(l1.th), s1 = Math.sin(l1.th);
      const c2 = Math.cos(l2.th), s2 = Math.sin(l2.th);
      const det = c1 * s2 - s1 * c2;
      if (Math.abs(det) < 1e-4) return null;
      return {
        x: cx + (s2 * l1.rho - s1 * l2.rho) / det,
        y: cy + (-c2 * l1.rho + c1 * l2.rho) / det
      };
    };

    for (const baseBin of chosenAngles) {
      const linesA = collectTopLines(baseBin);
      const linesB = collectTopLines((baseBin + 90) % numTheta);
      for (let i = 0; i < linesA.length; i++) {
        for (let j = i + 1; j < linesA.length; j++) {
          for (let m = 0; m < linesB.length; m++) {
            for (let n = m + 1; n < linesB.length; n++) {
              const pts = [
                intersect(linesA[i], linesB[m]),
                intersect(linesA[i], linesB[n]),
                intersect(linesA[j], linesB[n]),
                intersect(linesA[j], linesB[m])
              ].filter(Boolean);
              if (pts.length === 4) {
                const cand = evaluateCandidate(pts);
                if (cand) candidates.push(cand);
              }
            }
          }
        }
      }

      // 3-Side Aspect-Ratio Completion: handles close-up shots (like the tilted Back card) where the 4th border is clipped by the camera frame
      for (let m = 0; m < linesB.length; m++) {
        for (let n = m + 1; n < linesB.length; n++) {
          const spanB = Math.abs(linesB[m].rho - linesB[n].rho);
          if (spanB < Math.min(width, height) * 0.40) continue;
          const expectedA = spanB > Math.max(width, height) * 0.52 ? spanB / 1.54 : spanB * 1.54;
          for (let i = 0; i < Math.min(4, linesA.length); i++) {
            const lA = linesA[i];
            const sign = lA.rho < 0 ? 1 : -1;
            const lPartner = { th: lA.th, rho: lA.rho + sign * expectedA, v: lA.v * 0.8 };
            const pts = [
              intersect(lA, linesB[m]),
              intersect(lA, linesB[n]),
              intersect(lPartner, linesB[n]),
              intersect(lPartner, linesB[m])
            ].filter(Boolean);
            if (pts.length === 4) {
              const cand = evaluateCandidate(pts);
              if (cand) candidates.push(cand);
            }
          }
        }
      }
    }
  } catch {
    // keep other candidates
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.edgeScore >= 0.22 || best.areaRatio < 0.92) {
      const refinedPts = best.isExactInteriorUnion ? best.pts : refitEdgesExact(best.pts);
      return refinedPts.map(p => ({ x: p.x / width, y: p.y / height }));
    }
  }

  // Fallback for already-cropped scans: trim any uniform outer margin strips cleanly
  let top = 0, bottom = height - 1, left = 0, right = width - 1;
  const maxTrimY = Math.floor(height * 0.14);
  const maxTrimX = Math.floor(width * 0.14);
  const rowDiffFromEdge = (y) => {
    let diffAcc = 0;
    for (let x = Math.floor(width * 0.12); x < width * 0.88; x += 6) {
      const i = (y * width + x) * 4;
      diffAcc += Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]);
    }
    return diffAcc / Math.max(1, (width * 0.76) / 6);
  };
  const colDiffFromEdge = (x) => {
    let diffAcc = 0;
    for (let y = Math.floor(height * 0.12); y < height * 0.88; y += 6) {
      const i = (y * width + x) * 4;
      diffAcc += Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]);
    }
    return diffAcc / Math.max(1, (height * 0.76) / 6);
  };
  while (top < maxTrimY && rowDiffFromEdge(top) < 18) top++;
  while (bottom > height - 1 - maxTrimY && rowDiffFromEdge(bottom) < 18) bottom--;
  while (left < maxTrimX && colDiffFromEdge(left) < 18) left++;
  while (right > width - 1 - maxTrimX && colDiffFromEdge(right) < 18) right--;

  return [
    { x: Math.max(0.005, left / width), y: Math.max(0.005, top / height) },
    { x: Math.min(0.995, right / width), y: Math.max(0.005, top / height) },
    { x: Math.min(0.995, right / width), y: Math.min(0.995, bottom / height) },
    { x: Math.max(0.005, left / width), y: Math.min(0.995, bottom / height) }
  ];
}

/**
 * Solves 8x8 Gaussian elimination to compute inverse homography matrix mapping dst -> src.
 */
function computeHomography(dstPts, srcPts) {
  const A = Array.from({ length: 8 }, () => new Float64Array(9));
  for (let i = 0; i < 4; i++) {
    const x = dstPts[i].x;
    const y = dstPts[i].y;
    const u = srcPts[i].x;
    const v = srcPts[i].y;

    const r1 = A[2 * i];
    r1[0] = x; r1[1] = y; r1[2] = 1;
    r1[6] = -u * x; r1[7] = -u * y; r1[8] = u;

    const r2 = A[2 * i + 1];
    r2[3] = x; r2[4] = y; r2[5] = 1;
    r2[6] = -v * x; r2[7] = -v * y; r2[8] = v;
  }

  for (let col = 0; col < 8; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivotRow][col])) pivotRow = row;
    }
    const tmp = A[col];
    A[col] = A[pivotRow];
    A[pivotRow] = tmp;

    const div = A[col][col];
    if (Math.abs(div) < 1e-12) continue;
    for (let j = col; j <= 8; j++) A[col][j] /= div;

    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = A[row][col];
      for (let j = col; j <= 8; j++) A[row][j] -= factor * A[col][j];
    }
  }

  return [
    A[0][8], A[1][8], A[2][8],
    A[3][8], A[4][8], A[5][8],
    A[6][8], A[7][8], 1
  ];
}

/**
 * Warps a source ImageData using 4 normalized corners into a perfectly rectangular flat NID scan.
 */
export function warpCardImageData(srcData, srcW, srcH, normCorners, dstW = NID_CANVAS_W, dstH = NID_CANVAS_H, showBlackBorder = true) {
  const ordered = orderQuadCorners(normCorners);
  const absPts = ordered.map(p => ({ x: p.x * srcW, y: p.y * srcH }));

  // Auto-upright portrait mobile shot so long card axis becomes horizontal CR80 width
  const avgW = (dist2(absPts[0], absPts[1]) + dist2(absPts[3], absPts[2])) / 2;
  const avgH = (dist2(absPts[0], absPts[3]) + dist2(absPts[1], absPts[2])) / 2;
  const mappedSrc = avgH > avgW * 1.15
    ? [absPts[3], absPts[0], absPts[1], absPts[2]]
    : absPts;

  const dstPts = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 }
  ];

  const H = computeHomography(dstPts, mappedSrc);
  const out = new Uint8ClampedArray(dstW * dstH * 4);

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const denom = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / denom;
      const sy = (H[3] * x + H[4] * y + H[5]) / denom;

      const oIdx = (y * dstW + x) * 4;
      // Fill any off-frame projective corner triangle with clean white card paper instead of smearing edge clutter
      if (sx < 0 || sx >= srcW - 1 || sy < 0 || sy >= srcH - 1) {
        out[oIdx] = 250;
        out[oIdx + 1] = 250;
        out[oIdx + 2] = 248;
        out[oIdx + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      out[oIdx] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      out[oIdx + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
      out[oIdx + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
      out[oIdx + 3] = 255;
    }
  }
  // Check residual outer border clutter strips (max ~2.5%) and rectify any inner/bowed black border frame edge-to-edge
  return trimResidualWarpedBorder(out, dstW, dstH, showBlackBorder);
}

/**
 * 1) Strips any contiguous dark/gray outer border halo rows/cols (<=2.5% per side) after warp so 0 background leaks survive.
 * 2) Detects if the card has an inner or bowed printed black rectangular border frame (within 0..8.5% of each edge),
 *    fits a smooth parabolic bow curve d(u) on all 4 sides, applies a Coons-patch transfinite bilinear warp to map
 *    the 4 black border centerlines directly to the outer [0..W-1, 0..H-1] edges (eliminating 100% of outer white
 *    paper margins and mid-edge waviness/bowing), and normalizes the black border so it is 100% straight and orthogonal.
 */
function trimResidualWarpedBorder(pixels, W, H, showBlackBorder = true) {
  // Estimate card surface brightness from interior bright margin band (rows/cols ~6%..94% inside)
  const sampleLums = [];
  for (let y = Math.floor(H * 0.06); y < Math.floor(H * 0.94); y += Math.max(1, Math.floor(H / 20))) {
    for (let x = Math.floor(W * 0.06); x < Math.floor(W * 0.94); x += Math.max(1, Math.floor(W / 24))) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      if (lum > 150) sampleLums.push(lum);
    }
  }
  sampleLums.sort((a, b) => a - b);
  const cardRefLum = sampleLums.length ? sampleLums[Math.floor(sampleLums.length * 0.85)] : 240;
  const clutterCutLum = cardRefLum - 36;
  const isSmartCard = isSmartNidCardImageData(pixels, W, H);

  // Step 1: On Laminated Paper NID cards, rectify the inner printed black border frame edge-to-edge.
  // On Smart NID cards (which have no printed inner black border frame), skip inner border search so the
  // guilloche background, top barcode, and bottom MRZ are never inward-cropped!
  if (!isSmartCard) {
    const blackFrameRectified = detectAndRectifyBlackBorderFrame(pixels, W, H, cardRefLum, showBlackBorder);
    if (blackFrameRectified) {
      return blackFrameRectified;
    }
  }

  // Step 2: Otherwise, strip any residual outer background clutter rows/cols (<= 2.5% per side)
  const isClutterRow = (y) => {
    let bad = 0, cnt = 0;
    for (let x = Math.floor(W * 0.12); x < Math.floor(W * 0.88); x += 4) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      if (lum < clutterCutLum) bad++;
      cnt++;
    }
    return cnt > 0 && bad / cnt > 0.35;
  };
  const isClutterCol = (x) => {
    let bad = 0, cnt = 0;
    for (let y = Math.floor(H * 0.12); y < Math.floor(H * 0.88); y += 4) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      if (lum < clutterCutLum) bad++;
      cnt++;
    }
    return cnt > 0 && bad / cnt > 0.35;
  };

  const maxY = Math.floor(H * 0.025);
  const maxX = Math.floor(W * 0.025);
  let top = 0, bot = H - 1, left = 0, right = W - 1;
  while (top < maxY && isClutterRow(top)) top++;
  while (bot > H - 1 - maxY && isClutterRow(bot)) bot--;
  while (left < maxX && isClutterCol(left)) left++;
  while (right > W - 1 - maxX && isClutterCol(right)) right--;

  let current = pixels;
  if (top !== 0 || bot !== H - 1 || left !== 0 || right !== W - 1) {
    // Resample tightly trimmed crop cleanly back to W x H
    const cW = Math.max(1, right - left);
    const cH = Math.max(1, bot - top);
    const resampled = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const sy = top + (y / Math.max(1, H - 1)) * cH;
      const y0 = clamp(Math.floor(sy), 0, H - 2);
      const fy = sy - y0;
      for (let x = 0; x < W; x++) {
        const sx = left + (x / Math.max(1, W - 1)) * cW;
        const x0 = clamp(Math.floor(sx), 0, W - 2);
        const fx = sx - x0;
        const i00 = (y0 * W + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + W * 4;
        const i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const oIdx = (y * W + x) * 4;
        resampled[oIdx] = pixels[i00] * w00 + pixels[i10] * w10 + pixels[i01] * w01 + pixels[i11] * w11;
        resampled[oIdx + 1] = pixels[i00 + 1] * w00 + pixels[i10 + 1] * w10 + pixels[i01 + 1] * w01 + pixels[i11 + 1] * w11;
        resampled[oIdx + 2] = pixels[i00 + 2] * w00 + pixels[i10 + 2] * w10 + pixels[i01 + 2] * w01 + pixels[i11 + 2] * w11;
        resampled[oIdx + 3] = 255;
      }
    }
    current = resampled;
  }

  if (isSmartCard) {
    const leveledSmart = deskewCardTextLines(current, W, H, cardRefLum);
    // Clean 100% of any background fabric/desk triangles outside the physical CR80 rounded corners (radius ~46px at 300 DPI)
    // by filling the outer corner arc smoothly with the adjacent inner card margin color, plus a neat 2px outer frame
    const cornerR = 46;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const distEdge = Math.min(x, W - 1 - x, y, H - 1 - y);
        const oIdx = (y * W + x) * 4;
        if (showBlackBorder && distEdge <= 1) {
          leveledSmart[oIdx] = 42;
          leveledSmart[oIdx + 1] = 46;
          leveledSmart[oIdx + 2] = 52;
          continue;
        }
        const dx = x < cornerR ? (cornerR - x) : (x > W - 1 - cornerR ? (x - (W - 1 - cornerR)) : 0);
        const dy = y < cornerR ? (cornerR - y) : (y > H - 1 - cornerR ? (y - (H - 1 - cornerR)) : 0);
        if (dx > 0 && dy > 0) {
          const rDist = Math.hypot(dx, dy);
          if (rDist > cornerR - 4) {
            const blend = clamp((rDist - (cornerR - 4)) / 4, 0, 1);
            const refX = x < cornerR ? cornerR + 6 : W - 1 - cornerR - 6;
            const refY = y < cornerR ? cornerR + 6 : H - 1 - cornerR - 6;
            const rIdx1 = (refY * W + clamp(x, cornerR + 6, W - 1 - cornerR - 6)) * 4;
            const rIdx2 = (clamp(y, cornerR + 6, H - 1 - cornerR - 6) * W + refX) * 4;
            const tr = 0.5 * (leveledSmart[rIdx1] + leveledSmart[rIdx2]);
            const tg = 0.5 * (leveledSmart[rIdx1 + 1] + leveledSmart[rIdx2 + 1]);
            const tb = 0.5 * (leveledSmart[rIdx1 + 2] + leveledSmart[rIdx2 + 2]);
            leveledSmart[oIdx] = Math.round(leveledSmart[oIdx] * (1 - blend) + tr * blend);
            leveledSmart[oIdx + 1] = Math.round(leveledSmart[oIdx + 1] * (1 - blend) + tg * blend);
            leveledSmart[oIdx + 2] = Math.round(leveledSmart[oIdx + 2] * (1 - blend) + tb * blend);
          }
        }
      }
    }
    return leveledSmart;
  }
  return current;
}

/**
 * Detects a printed thin black rectangular border frame (straight or bowed/curved) within 0..8.5% of the card edges.
 * If present on all 4 sides, fits a 3-parameter parabolic curve d(u) on each side and applies a Coons-patch
 * transfinite bilinear warp so the black border is mapped strictly to [0..W-1, 0..H-1] with 0 outer whitespace
 * and 100% straight, orthogonal black border lines.
 */
/**
 * Automatically deskews the warped card (within +-4.2 deg in 0.15 deg steps) by maximizing
 * the horizontal projection variance of vertical text/divider gradients across the card interior.
 * Ensures all Bangla & English text lines are 100% horizontal and straight without non-linear distortion.
 */
function deskewCardTextLines(pixels, W, H, cardRefLum) {
  const x0 = Math.floor(W * 0.12), x1 = Math.floor(W * 0.88);
  const y0 = Math.floor(H * 0.10), y1 = Math.floor(H * 0.90);
  const sW = Math.floor((x1 - x0) / 2);
  const sH = Math.floor((y1 - y0) / 2);
  if (sW < 40 || sH < 40) return pixels;

  const vEdge = new Float32Array(sW * sH);
  for (let sy = 1; sy < sH - 1; sy++) {
    const py = y0 + sy * 2;
    for (let sx = 0; sx < sW; sx++) {
      const px = x0 + sx * 2;
      const iUp = ((py - 1) * W + px) * 4;
      const iDn = ((py + 1) * W + px) * 4;
      const lumUp = 0.299 * pixels[iUp] + 0.587 * pixels[iUp + 1] + 0.114 * pixels[iUp + 2];
      const lumDn = 0.299 * pixels[iDn] + 0.587 * pixels[iDn + 1] + 0.114 * pixels[iDn + 2];
      const diff = Math.abs(lumUp - lumDn);
      vEdge[sy * sW + sx] = diff > 18 ? diff : 0;
    }
  }

  const cX = sW * 0.5;
  const rowProj = new Float32Array(sH);
  const scoreAngle = (deg) => {
    const tanA = Math.tan((deg * Math.PI) / 180);
    rowProj.fill(0);
    for (let sy = 2; sy < sH - 2; sy++) {
      const rowBase = sy * sW;
      for (let sx = 0; sx < sW; sx++) {
        const val = vEdge[rowBase + sx];
        if (val === 0) continue;
        const projY = Math.round(sy - (sx - cX) * tanA);
        if (projY >= 0 && projY < sH) rowProj[projY] += val;
      }
    }
    let energy = 0;
    for (let sy = 1; sy < sH - 1; sy++) {
      const d = rowProj[sy] - rowProj[sy - 1];
      energy += d * d;
    }
    return energy;
  };

  const zeroScore = scoreAngle(0);
  let bestDeg = 0;
  let bestScore = zeroScore;
  // Search +-14.5 deg so even a heavily tilted card (like the 11 deg tilted Back card) is detected and leveled
  for (let deg = -5.5; deg <= 5.5; deg += 0.20) {
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestDeg = deg;
    }
  }
  for (let deg = bestDeg - 0.25; deg <= bestDeg + 0.25; deg += 0.05) {
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestDeg = deg;
    }
  }

  if (Math.abs(bestDeg) < 0.15 || bestScore < zeroScore * 1.04) {
    return pixels;
  }

  const rad = (bestDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const cx = (W - 1) * 0.5;
  const cy = (H - 1) * 0.5;
  const rotated = new Uint8ClampedArray(W * H * 4);
  const fillVal = Math.round(clamp(cardRefLum, 242, 255));

  for (let y = 0; y < H; y++) {
    const dy = y - cy;
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const sx = cx + dx * cosA - dy * sinA;
      const sy = cy + dx * sinA + dy * cosA;
      const oIdx = (y * W + x) * 4;
      if (sx < 0 || sx >= W - 1 || sy < 0 || sy >= H - 1) {
        rotated[oIdx] = fillVal;
        rotated[oIdx + 1] = fillVal;
        rotated[oIdx + 2] = fillVal;
        rotated[oIdx + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + W * 4;
      const i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      rotated[oIdx] = pixels[i00] * w00 + pixels[i10] * w10 + pixels[i01] * w01 + pixels[i11] * w11;
      rotated[oIdx + 1] = pixels[i00 + 1] * w00 + pixels[i10 + 1] * w10 + pixels[i01 + 1] * w01 + pixels[i11 + 1] * w11;
      rotated[oIdx + 2] = pixels[i00 + 2] * w00 + pixels[i10 + 2] * w10 + pixels[i01 + 2] * w01 + pixels[i11 + 2] * w11;
      rotated[oIdx + 3] = 255;
    }
  }
  return rotated;
}

/**
 * 2-Point Line RANSAC Black-Border Frame Rectifier + Text Baseline Deskew:
 * - Tracks straight or diagonal/tilted printed black border lines (even when a gray lamination wedge or brown
 *   desk triangle up to 14..22% deep sits outside the black border line, as in the user's red-marked screenshot!)
 * - Distinguishes a deep diagonal black border line from interior text by requiring that any stroke deeper than 16px
 *   has non-white lamination/background clutter outside it (avgOuterLum < cardRefLum - 14) and bright white card paper inside it!
 * - Maps the 4 inner border curves directly to [12 .. W-13] x [12 .. H-13] and runs deskewCardTextLines so all
 *   lamination/background wedges are 100% eliminated and all text lines are 100% straight and unclipped.
 */
function detectAndRectifyBlackBorderFrame(rawPixels, W, H, cardRefLum, showBlackBorder = true) {
  const getPixelLum = (buf, x, y) => {
    const cx = clamp(Math.round(x), 0, W - 1);
    const cy = clamp(Math.round(y), 0, H - 1);
    const i = (cy * W + cx) * 4;
    return 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  };
  const getPixelSat = (buf, x, y) => {
    const cx = clamp(Math.round(x), 0, W - 1);
    const cy = clamp(Math.round(y), 0, H - 1);
    const i = (cy * W + cx) * 4;
    return Math.max(buf[i], buf[i + 1], buf[i + 2]) - Math.min(buf[i], buf[i + 1], buf[i + 2]);
  };

  // Measure any residual vertical bow AND left-to-right tilt from the internal full-width horizontal divider line
  const measureInternalHorizProfile = (buf) => {
    const bandTop = Math.floor(H * 0.13);
    const bandBot = Math.floor(H * 0.36);
    const cols = 25;
    const xStations = [];
    for (let c = 0; c < cols; c++) {
      xStations.push(Math.round((0.06 + (c / (cols - 1)) * 0.88) * (W - 1)));
    }
    let bestY = -1, bestHits = 0;
    for (let y = bandTop; y <= bandBot; y++) {
      let hits = 0;
      for (let c = 0; c < cols; c++) {
        const x = xStations[c];
        const minL = Math.min(getPixelLum(buf, x, y - 2), getPixelLum(buf, x, y), getPixelLum(buf, x, y + 2));
        if (minL < cardRefLum - 45) hits++;
      }
      if (hits > bestHits) {
        bestHits = hits;
        bestY = y;
      }
    }
    if (bestHits < Math.floor(cols * 0.72)) return { tilt: 0, bow: 0 };

    const pts = [];
    for (let c = 0; c < cols; c++) {
      const u = 0.06 + (c / (cols - 1)) * 0.88;
      const x = xStations[c];
      let minL = 255, minY = bestY;
      for (let dy = -12; dy <= 12; dy++) {
        const y = clamp(bestY + dy, bandTop, bandBot);
        const l = getPixelLum(buf, x, y);
        if (l < minL) {
          minL = l;
          minY = y;
        }
      }
      if (minL < cardRefLum - 40) {
        pts.push({ u, y: minY });
      }
    }
    if (pts.length < 15) return { tilt: 0, bow: 0 };
    const leftPts = pts.filter(p => p.u <= 0.22).map(p => p.y).sort((a, b) => a - b);
    const rightPts = pts.filter(p => p.u >= 0.78).map(p => p.y).sort((a, b) => a - b);
    const midPts = pts.filter(p => p.u >= 0.38 && p.u <= 0.62).map(p => p.y).sort((a, b) => a - b);
    if (!leftPts.length || !rightPts.length || !midPts.length) return { tilt: 0, bow: 0 };
    const yL = leftPts[Math.floor(leftPts.length / 2)];
    const yR = rightPts[Math.floor(rightPts.length / 2)];
    const yM = midPts[Math.floor(midPts.length / 2)];
    return {
      tilt: clamp(yR - yL, -14, 14),
      bow: clamp(yM - 0.5 * (yL + yR), -10, 10)
    };
  };

  const darkCut = Math.min(165, cardRefLum - 40);
  const brightRecover = Math.max(185, cardRefLum - 35);

  const fitBorderInnerCurve = (buf, side, internalProf = { tilt: 0, bow: 0 }) => {
    const isHoriz = side === 'top' || side === 'bottom';
    const spanLen = isHoriz ? W : H;
    const maxD = 14;
    const stations = 36;
    const stationCands = [];

    for (let s = 0; s < stations; s++) {
      const u = 0.04 + (s / (stations - 1)) * 0.92;
      const pos = Math.round(u * (spanLen - 1));

      const prof = new Float32Array(maxD + 14);
      const minProf = new Float32Array(maxD + 14);
      const satProf = new Float32Array(maxD + 14);
      for (let d = 0; d < prof.length; d++) {
        let sumL = 0, sumS = 0, minL = 255;
        for (let t = -2; t <= 2; t++) {
          const tp = clamp(pos + t * 2, 0, spanLen - 1);
          let l = 255, st = 0;
          if (side === 'top') { l = getPixelLum(buf, tp, d); st = getPixelSat(buf, tp, d); }
          else if (side === 'bottom') { l = getPixelLum(buf, tp, H - 1 - d); st = getPixelSat(buf, tp, H - 1 - d); }
          else if (side === 'left') { l = getPixelLum(buf, d, tp); st = getPixelSat(buf, d, tp); }
          else { l = getPixelLum(buf, W - 1 - d, tp); st = getPixelSat(buf, W - 1 - d, tp); }
          sumL += l;
          sumS += st;
          if (l < minL) minL = l;
        }
        prof[d] = sumL / 5;
        minProf[d] = minL;
        satProf[d] = sumS / 5;
      }

      for (let d = 0; d <= maxD; d++) {
        const lumD = minProf[d];
        if (lumD >= darkCut) continue;

        let maxInnerBright = 0;
        for (let k = 2; k <= 8 && d + k < prof.length; k++) {
          if (prof[d + k] > maxInnerBright && satProf[d + k] < 42) {
            maxInnerBright = prof[d + k];
          }
        }
        if (maxInnerBright < Math.min(brightRecover, maxInnerBright + 25) && maxInnerBright < 135) continue;
        if (maxInnerBright - lumD < 22) continue;

        const midCut = (lumD + maxInnerBright) * 0.5;
        let dEnd = d;
        while (dEnd + 1 < prof.length && dEnd - d <= 10 && minProf[dEnd + 1] < midCut) dEnd++;
        let dStart = d;
        while (dStart - 1 >= 0 && d - dStart <= 10 && minProf[dStart - 1] < midCut) dStart--;

        const thick = dEnd - dStart + 1;
        if (thick > 12) continue;

        let minStrokeLum = lumD;
        let strokeSat = satProf[d];
        for (let k = dStart; k <= dEnd; k++) {
          if (prof[k] < minStrokeLum) {
            minStrokeLum = prof[k];
            strokeSat = satProf[k];
          }
        }
        if (strokeSat > 58) {
          d = dEnd;
          continue;
        }

        const innerEdgeD = clamp(dEnd + 1.2, 2, maxD + 3);
        stationCands.push({ u, d: innerEdgeD });
        break;
      }
    }

    if (stationCands.length < 8) return null;

    const leftD = stationCands.filter(p => p.u <= 0.25).map(p => p.d).sort((a, b) => a - b);
    const rightD = stationCands.filter(p => p.u >= 0.75).map(p => p.d).sort((a, b) => a - b);
    const midD = stationCands.filter(p => p.u >= 0.35 && p.u <= 0.65).map(p => p.d).sort((a, b) => a - b);
    const allD = stationCands.map(p => p.d).sort((a, b) => a - b);
    const medAll = allD[Math.floor(allD.length / 2)];

    let bestD0 = leftD.length >= 2 ? leftD[Math.floor(leftD.length / 2)] : medAll;
    let bestD1 = rightD.length >= 2 ? rightD[Math.floor(rightD.length / 2)] : medAll;
    const bestDM = midD.length >= 2 ? midD[Math.floor(midD.length / 2)] : medAll;

    let bow = clamp(bestDM - 0.5 * (bestD0 + bestD1), -8, 8);
    if (side === 'top') {
      if (Math.abs(internalProf.tilt) >= 3) {
        bestD1 = clamp(bestD0 + internalProf.tilt, 1.5, maxD + 4);
      }
      if (Math.abs(internalProf.bow) > Math.abs(bow)) {
        bow = clamp(0.3 * bow + 0.7 * internalProf.bow, -8, 8);
      }
    } else if (side === 'bottom' && Math.abs(internalProf.bow) > Math.abs(bow)) {
      bow = clamp(0.3 * bow - 0.7 * internalProf.bow, -8, 8);
    }

    const evalCurve = (u) => clamp(bestD0 * (1 - u) + bestD1 * u + bow * 4 * u * (1 - u), 1.5, maxD + 4);
    return {
      d0: bestD0,
      d1: bestD1,
      bow,
      inliers: stationCands.length,
      evalCurve,
      meanD: 0.5 * (bestD0 + bestD1) + 0.5 * bow
    };
  };

  const rectifyPass = (inputBuf) => {
    const internalProf = measureInternalHorizProfile(inputBuf);
    let topC = fitBorderInnerCurve(inputBuf, 'top', internalProf);
    let botC = fitBorderInnerCurve(inputBuf, 'bottom', internalProf);
    let leftC = fitBorderInnerCurve(inputBuf, 'left');
    let rightC = fitBorderInnerCurve(inputBuf, 'right');

    const makeFallbackCurve = (d0Val, d1Val = d0Val, bowVal = 0) => ({
      d0: d0Val, d1: d1Val, bow: bowVal, inliers: 30, meanD: 0.5 * (d0Val + d1Val) + 0.5 * bowVal,
      evalCurve: (u) => d0Val * (1 - u) + d1Val * u + bowVal * 4 * u * (1 - u)
    });

    if (!topC) {
      const d0 = 3.5;
      const d1 = clamp(3.5 + internalProf.tilt, 1.5, 15);
      topC = makeFallbackCurve(d0, d1, clamp(internalProf.bow * 0.7, -7, 7));
    }
    if (!botC) botC = makeFallbackCurve(3.5, 3.5, clamp(-internalProf.bow * 0.7, -7, 7));
    if (!leftC) leftC = makeFallbackCurve(3.5);
    if (!rightC) rightC = makeFallbackCurve(3.5);

    // Flush outer charcoal-black border right at distEdge = 0..2 (3px thick, matching Photo 1!)
    const BORDER_MAX = 2;
    const INNER_START = 5;

    const out = new Uint8ClampedArray(W * H * 4);
    const topArr = new Float32Array(W);
    const botArr = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const u = clamp((x - INNER_START) / Math.max(1, W - 1 - 2 * INNER_START), 0, 1);
      topArr[x] = topC.evalCurve(u);
      botArr[x] = H - 1 - botC.evalCurve(u);
    }
    const leftArr = new Float32Array(H);
    const rightArr = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const v = clamp((y - INNER_START) / Math.max(1, H - 1 - 2 * INNER_START), 0, 1);
      leftArr[y] = leftC.evalCurve(v);
      rightArr[y] = W - 1 - rightC.evalCurve(v);
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const distEdge = Math.min(x, W - 1 - x, y, H - 1 - y);
        const oIdx = (y * W + x) * 4;

        if (distEdge < INNER_START) {
          if (showBlackBorder && distEdge <= BORDER_MAX) {
            out[oIdx] = 36;
            out[oIdx + 1] = 38;
            out[oIdx + 2] = 42;
          } else if (showBlackBorder && distEdge === BORDER_MAX + 1) {
            out[oIdx] = 165;
            out[oIdx + 1] = 167;
            out[oIdx + 2] = 170;
          } else {
            out[oIdx] = 255;
            out[oIdx + 1] = 255;
            out[oIdx + 2] = 255;
          }
          out[oIdx + 3] = 255;
          continue;
        }

        const u = (x - INNER_START) / Math.max(1, W - 1 - 2 * INNER_START);
        const v = (y - INNER_START) / Math.max(1, H - 1 - 2 * INNER_START);
        const L = leftArr[y];
        const R = rightArr[y];
        const T = topArr[x];
        const B = botArr[x];

        const sx = (1 - u) * L + u * R;
        const sy = (1 - v) * T + v * B;

        if (sx < 0 || sx >= W - 1 || sy < 0 || sy >= H - 1) {
          out[oIdx] = 255;
          out[oIdx + 1] = 255;
          out[oIdx + 2] = 255;
          out[oIdx + 3] = 255;
          continue;
        }

        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * W + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + W * 4;
        const i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;

        out[oIdx] = inputBuf[i00] * w00 + inputBuf[i10] * w10 + inputBuf[i01] * w01 + inputBuf[i11] * w11;
        out[oIdx + 1] = inputBuf[i00 + 1] * w00 + inputBuf[i10 + 1] * w10 + inputBuf[i01 + 1] * w01 + inputBuf[i11 + 1] * w11;
        out[oIdx + 2] = inputBuf[i00 + 2] * w00 + inputBuf[i10 + 2] * w10 + inputBuf[i01 + 2] * w01 + inputBuf[i11 + 2] * w11;
        out[oIdx + 3] = 255;
      }
    }
    return out;
  };

  // Pass 1: Rectify any slight border bow/tilt and place flush 3px outer charcoal-black border
  const pass1 = rectifyPass(rawPixels);
  // Pass 2: Fine text-baseline deskew so all horizontal text lines are 100% level (0.0 deg)
  const leveled = deskewCardTextLines(pass1, W, H, cardRefLum);
  if (leveled === pass1) return pass1;
  // Re-stamp crisp outer 0..4px border frame after fine deskew
  const BORDER_MAX = 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const distEdge = Math.min(x, W - 1 - x, y, H - 1 - y);
      if (distEdge > BORDER_MAX + 2) continue;
      const oIdx = (y * W + x) * 4;
      if (showBlackBorder && distEdge <= BORDER_MAX) {
        leveled[oIdx] = 36; leveled[oIdx + 1] = 38; leveled[oIdx + 2] = 42;
      } else if (showBlackBorder && distEdge === BORDER_MAX + 1) {
        leveled[oIdx] = 165; leveled[oIdx + 1] = 167; leveled[oIdx + 2] = 170;
      } else {
        leveled[oIdx] = 255; leveled[oIdx + 1] = 255; leveled[oIdx + 2] = 255;
      }
    }
  }
  return leveled;
}

export function applyScannerEnhance(pixels, W, H, mode = 'scanner') {
  if (mode === 'original') return pixels;

  // Smart NID Card True-Color Preservation Mode:
  // Preserves 100% of the original polycarbonate Smart NID Card colors (mint/teal-green & red Bangladesh flag guilloche,
  // gold metallic IC chip, monochrome B&W portrait, lime-green back band, purple Shapla hologram, top barcode & bottom MRZ)
  // by normalizing only a smooth scalar luminance field (zero per-channel white bleaching!) while sharpening text & barcode.
  if (isSmartNidCardImageData(pixels, W, H) && mode === 'scanner') {
    const gW = 8, gH = 6;
    const cellLum = new Float32Array(gW * gH);
    const cellW = W / gW, cellH = H / gH;
    const allBright = [];

    for (let gy = 0; gy < gH; gy++) {
      const y0 = Math.floor(gy * cellH), y1 = Math.min(H, Math.ceil((gy + 1) * cellH));
      for (let gx = 0; gx < gW; gx++) {
        const x0 = Math.floor(gx * cellW), x1 = Math.min(W, Math.ceil((gx + 1) * cellW));
        const lums = [];
        for (let y = y0; y < y1; y += 3) {
          for (let x = x0; x < x1; x += 3) {
            const i = (y * W + x) * 4;
            const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            if (l >= 120) {
              lums.push(l);
              allBright.push(l);
            }
          }
        }
        lums.sort((a, b) => a - b);
        cellLum[gy * gW + gx] = lums.length >= 6 ? clamp(lums[Math.floor(lums.length * 0.86)], 155, 246) : 0;
      }
    }
    allBright.sort((a, b) => a - b);
    const refLum = allBright.length ? clamp(allBright[Math.floor(allBright.length * 0.85)], 185, 236) : 212;
    for (let k = 0; k < gW * gH; k++) {
      if (cellLum[k] < refLum * 0.84) cellLum[k] = refLum * 0.90;
    }

    const smoothLum = new Float32Array(gW * gH);
    for (let gy = 0; gy < gH; gy++) {
      for (let gx = 0; gx < gW; gx++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = clamp(gy + dy, 0, gH - 1), nx = clamp(gx + dx, 0, gW - 1);
            s += cellLum[ny * gW + nx];
            c++;
          }
        }
        smoothLum[gy * gW + gx] = s / c;
      }
    }

    const rawLumArr = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const idx = i * 4;
      rawLumArr[i] = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
    }

    const targetCardBright = clamp(refLum * 0.35 + 226 * 0.65, 208, 232);
    const smartOut = new Uint8ClampedArray(pixels.length);

    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / cellH - 0.5;
      const gy0 = clamp(Math.floor(fy), 0, gH - 1), gy1 = clamp(gy0 + 1, 0, gH - 1);
      const wy = clamp(fy - gy0, 0, 1);

      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / cellW - 0.5;
        const gx0 = clamp(Math.floor(fx), 0, gW - 1), gx1 = clamp(gx0 + 1, 0, gW - 1);
        const wx = clamp(fx - gx0, 0, 1);

        const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
        const estL =
          smoothLum[gy0 * gW + gx0] * w00 +
          smoothLum[gy0 * gW + gx1] * w10 +
          smoothLum[gy1 * gW + gx0] * w01 +
          smoothLum[gy1 * gW + gx1] * w11;

        // Equal scalar multiplier across R, G, and B preserves 100% of original Smart Card hue & chroma!
        const scale = clamp(targetCardBright / Math.max(150, estL), 0.94, 1.24);
        const pIdx = y * W + x;
        const i = pIdx * 4;
        const lum0 = rawLumArr[pIdx];

        let locSum = 0, locCnt = 0, locMax = lum0;
        for (let dy = -2; dy <= 2; dy += 2) {
          const ny = clamp(y + dy, 0, H - 1) * W;
          for (let dx = -2; dx <= 2; dx += 2) {
            const nl = rawLumArr[ny + clamp(x + dx, 0, W - 1)];
            if (nl > locMax) locMax = nl;
            locSum += nl;
            locCnt++;
          }
        }
        const localDip = Math.max(locSum / locCnt - lum0, (locMax - lum0) * 0.65);

        let r = clamp(pixels[i] * scale, 0, 255);
        let g = clamp(pixels[i + 1] * scale, 0, 255);
        let b = clamp(pixels[i + 2] * scale, 0, 255);

        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;

        // Reinforce dark text, PDF417 barcode, and MRZ strokes (localDip > 2.5 and low saturation)
        // while keeping the colorful pastel security guilloche 100% true to original color!
        const isDarkInk = lum < 160 && sat < 34 && localDip > 2.2;
        const pull = isDarkInk ? (localDip - 2.0) * 0.55 : (localDip > 4.0 ? (localDip - 4.0) * 0.25 : 0);
        const mapSmart = (c) => clamp(((c - pull - 10) / 238) * 252, 0, 255);
        r = mapSmart(r);
        g = mapSmart(g);
        b = mapSmart(b);

        // Gentle natural vibrance (1.14x) on the Smart Card pastel guilloche, flag circle, and gold chip
        const mLum = 0.299 * r + 0.587 * g + 0.114 * b;
        const vib = lum >= 115 ? 1.14 : 1.04;
        smartOut[i] = clamp(Math.round(mLum + (r - mLum) * vib), 0, 255);
        smartOut[i + 1] = clamp(Math.round(mLum + (g - mLum) * vib), 0, 255);
        smartOut[i + 2] = clamp(Math.round(mLum + (b - mLum) * vib), 0, 255);
        smartOut[i + 3] = 255;
      }
    }

    const sharpSmart = new Uint8ClampedArray(smartOut.length);
    sharpSmart.set(smartOut);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const center = smartOut[i + c];
          const avgNb = (smartOut[i - 4 + c] + smartOut[i + 4 + c] + smartOut[i - W * 4 + c] + smartOut[i + W * 4 + c]) * 0.25;
          sharpSmart[i + c] = clamp(Math.round(center + 0.24 * (center - avgNb)), 0, 255);
        }
      }
    }
    return sharpSmart;
  }

  const gW = 24;
  const gH = 16;
  const bgRMap = new Float32Array(gW * gH);
  const bgGMap = new Float32Array(gW * gH);
  const bgBMap = new Float32Array(gW * gH);
  const cellW = W / gW;
  const cellH = H / gH;

  for (let gy = 0; gy < gH; gy++) {
    const y0 = Math.floor(gy * cellH);
    const y1 = Math.min(H, Math.ceil((gy + 1) * cellH));
    for (let gx = 0; gx < gW; gx++) {
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.min(W, Math.ceil((gx + 1) * cellW));
      const rs = [], gs = [], bs = [];
      for (let y = y0; y < y1; y += 3) {
        for (let x = x0; x < x1; x += 3) {
          const i = (y * W + x) * 4;
          const pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];
          if (Math.max(pr, pg, pb) - Math.min(pr, pg, pb) <= 42) {
            rs.push(pr);
            gs.push(pg);
            bs.push(pb);
          }
        }
      }
      rs.sort((a, b) => a - b);
      gs.sort((a, b) => a - b);
      bs.sort((a, b) => a - b);
      const idx85 = Math.floor(rs.length * 0.85);
      bgRMap[gy * gW + gx] = rs.length >= 4 ? clamp(rs[idx85], 120, 254) : 0;
      bgGMap[gy * gW + gx] = gs.length >= 4 ? clamp(gs[idx85], 120, 254) : 0;
      bgBMap[gy * gW + gx] = bs.length >= 4 ? clamp(bs[idx85], 120, 254) : 0;
    }
  }

  // Fill any portrait/barcode cells (where low-sat paper was scarce) using the same column's top/middle paper brightness,
  // while allowing true shaded paper columns (down to 72% of global median) so strong left-to-right outdoor shadow gradients
  // (like ratna_front and ratna_back) are 100% normalized to uniform pure #FFFFFF white paper!
  const validBgR = [...bgRMap].filter(v => v > 0).sort((a, b) => a - b);
  const validBgG = [...bgGMap].filter(v => v > 0).sort((a, b) => a - b);
  const validBgB = [...bgBMap].filter(v => v > 0).sort((a, b) => a - b);
  const medPaperR = validBgR[Math.floor(validBgR.length * 0.65)] || 215;
  const medPaperG = validBgG[Math.floor(validBgG.length * 0.65)] || 215;
  const medPaperB = validBgB[Math.floor(validBgB.length * 0.65)] || 215;
  for (let gx = 0; gx < gW; gx++) {
    // Estimate this column's white paper reference from its brightest paper cells
    const colR = [], colG = [], colB = [];
    for (let gy = 0; gy < gH; gy++) {
      const k = gy * gW + gx;
      if (bgRMap[k] >= medPaperR * 0.72) {
        colR.push(bgRMap[k]);
        colG.push(bgGMap[k]);
        colB.push(bgBMap[k]);
      }
    }
    colR.sort((a, b) => a - b);
    colG.sort((a, b) => a - b);
    colB.sort((a, b) => a - b);
    const colRefR = colR.length ? colR[Math.floor(colR.length * 0.75)] : medPaperR * 0.88;
    const colRefG = colG.length ? colG[Math.floor(colG.length * 0.75)] : medPaperG * 0.88;
    const colRefB = colB.length ? colB[Math.floor(colB.length * 0.75)] : medPaperB * 0.88;
    for (let gy = 0; gy < gH; gy++) {
      const k = gy * gW + gx;
      if (bgRMap[k] < colRefR * 0.90) bgRMap[k] = colRefR * 0.92;
      if (bgGMap[k] < colRefG * 0.90) bgGMap[k] = colRefG * 0.92;
      if (bgBMap[k] < colRefB * 0.90) bgBMap[k] = colRefB * 0.92;
    }
  }

  const smoothGrid = (grid) => {
    let a = new Float32Array(grid);
    let b = new Float32Array(gW * gH);
    for (let pass = 0; pass < 3; pass++) {
      for (let gy = 0; gy < gH; gy++) {
        for (let gx = 0; gx < gW; gx++) {
          let acc = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ny = clamp(gy + dy, 0, gH - 1);
              const nx = clamp(gx + dx, 0, gW - 1);
              acc += a[ny * gW + nx];
              cnt++;
            }
          }
          b[gy * gW + gx] = acc / cnt;
        }
      }
      a = new Float32Array(b);
    }
    return a;
  };

  const smoothR = smoothGrid(bgRMap);
  const smoothG = smoothGrid(bgGMap);
  const smoothB = smoothGrid(bgBMap);

  // First pass: compute white-balanced RGB and per-pixel luminance
  const wbRGB = new Float32Array(W * H * 3);
  const wbLum = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const fy = (y + 0.5) / cellH - 0.5;
    const gy0 = clamp(Math.floor(fy), 0, gH - 1);
    const gy1 = clamp(gy0 + 1, 0, gH - 1);
    const wy = clamp(fy - gy0, 0, 1);

    for (let x = 0; x < W; x++) {
      const fx = (x + 0.5) / cellW - 0.5;
      const gx0 = clamp(Math.floor(fx), 0, gW - 1);
      const gx1 = clamp(gx0 + 1, 0, gW - 1);
      const wx = clamp(fx - gx0, 0, 1);

      const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
      const i00 = gy0 * gW + gx0, i10 = gy0 * gW + gx1, i01 = gy1 * gW + gx0, i11 = gy1 * gW + gx1;

      const estR = smoothR[i00] * w00 + smoothR[i10] * w10 + smoothR[i01] * w01 + smoothR[i11] * w11;
      const estG = smoothG[i00] * w00 + smoothG[i10] * w10 + smoothG[i01] * w01 + smoothG[i11] * w11;
      const estB = smoothB[i00] * w00 + smoothB[i10] * w10 + smoothB[i01] * w01 + smoothB[i11] * w11;

      const pIdx = y * W + x;
      const i = pIdx * 4;
      const r = clamp((pixels[i] / Math.max(110, estR)) * 252, 0, 255);
      const g = clamp((pixels[i + 1] / Math.max(110, estG)) * 252, 0, 255);
      const b = clamp((pixels[i + 2] / Math.max(110, estB)) * 252, 0, 255);

      wbRGB[pIdx * 3] = r;
      wbRGB[pIdx * 3 + 1] = g;
      wbRGB[pIdx * 3 + 2] = b;
      wbLum[pIdx] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  // Full portrait photo bounding box on Front card (x: 3.5%..29.5%, y: 31%..73%)
  // Check if this card has a portrait photo in that box (smooth skin/hair tones vs Back card text/white paper)
  const pX0 = Math.floor(W * 0.035), pX1 = Math.floor(W * 0.295);
  const pY0 = Math.floor(H * 0.31), pY1 = Math.floor(H * 0.72);
  let portraitTonePixels = 0, portraitTotal = 0;
  for (let y = Math.floor(H * 0.36); y < Math.floor(H * 0.68); y += 3) {
    for (let x = Math.floor(W * 0.06); x < Math.floor(W * 0.27); x += 3) {
      const pIdx = y * W + x;
      const l = wbLum[pIdx];
      if (l >= 60 && l <= 232) portraitTonePixels++;
      portraitTotal++;
    }
  }
  const hasFrontPortrait = portraitTotal > 0 && (portraitTonePixels / portraitTotal) >= 0.42;

  // Edge-connected BFS studio background mask for the Front portrait box:
  // Floods 100% of the studio paper + soft shadows around the head/hijab/shoulders from the portrait box edges,
  // while stopping cleanly at hair/hijab/skin/clothing contours so the face & forehead are NEVER touched.
  const pW = pX1 - pX0 + 1;
  const pH = pY1 - pY0 + 1;
  let portraitBgAlpha = null;
  if (hasFrontPortrait && mode !== 'bw' && pW > 20 && pH > 20) {
    const bgRs = [], bgGs = [], bgBs = [];
    const topBandEnd = Math.min(pY1, pY0 + Math.max(12, Math.floor(pH * 0.10)));
    const sideBandW = Math.max(14, Math.floor(pW * 0.14));
    for (let y = pY0 + 2; y <= topBandEnd; y += 2) {
      for (let x = pX0 + 3; x <= pX1 - 3; x += 2) {
        if (x > pX0 + sideBandW && x < pX1 - sideBandW) continue;
        const idx = (y * W + x) * 4;
        bgRs.push(pixels[idx]);
        bgGs.push(pixels[idx + 1]);
        bgBs.push(pixels[idx + 2]);
      }
    }
    bgRs.sort((a, b) => a - b);
    bgGs.sort((a, b) => a - b);
    bgBs.sort((a, b) => a - b);
    const q75 = Math.floor(bgRs.length * 0.75);
    const bgR = bgRs[q75] || medPaperR;
    const bgG = bgGs[q75] || medPaperG;
    const bgB = bgBs[q75] || medPaperB;
    const bgLum = Math.max(1, 0.299 * bgR + 0.587 * bgG + 0.114 * bgB);

    const bgMask = new Uint8Array(pW * pH);
    const queue = new Int32Array(pW * pH);
    let qHead = 0, qTail = 0;

    const isBgPixel = (lx, ly) => {
      const gx = pX0 + lx;
      const gy = pY0 + ly;
      const pIdx = gy * W + gx;
      const lum = wbLum[pIdx];
      // Lower 28% of portrait box is shoulder/collar zone: require brighter paper to avoid eating white shirts
      const inLowerZone = ly > pH * 0.72;
      if (lum < (inLowerZone ? 212 : 172)) return false;
      const idx = pIdx * 4;
      const rr = pixels[idx], rg = pixels[idx + 1], rb = pixels[idx + 2];
      const rawLum = 0.299 * rr + 0.587 * rg + 0.114 * rb;
      const scaleBg = rawLum / bgLum;
      const chromDist =
        Math.abs(rr - bgR * scaleBg) +
        Math.abs(rg - bgG * scaleBg) +
        Math.abs(rb - bgB * scaleBg);
      return chromDist <= (inLowerZone ? 16 : 28);
    };

    const trySeed = (lx, ly) => {
      const k = ly * pW + lx;
      if (bgMask[k]) return;
      if (isBgPixel(lx, ly)) {
        bgMask[k] = 1;
        queue[qTail++] = k;
      }
    };

    for (let lx = 0; lx < pW; lx++) trySeed(lx, 0);
    const seedMaxY = Math.floor(pH * 0.78);
    for (let ly = 1; ly <= seedMaxY; ly++) {
      trySeed(0, ly);
      trySeed(pW - 1, ly);
    }

    while (qHead < qTail) {
      const k = queue[qHead++];
      const lx = k % pW;
      const ly = (k - lx) / pW;
      if (lx > 0) trySeed(lx - 1, ly);
      if (lx + 1 < pW) trySeed(lx + 1, ly);
      if (ly > 0) trySeed(lx, ly - 1);
      if (ly + 1 < pH) trySeed(lx, ly + 1);
    }

    // 1px dilation into soft anti-aliased shadow fringe right along the head/hijab outline,
    // followed by a 3x3 box blur for silky smooth cutout feathering (zero gray/pink shadow halo!)
    const dilated = new Uint8Array(bgMask);
    for (let ly = 1; ly < pH - 1; ly++) {
      for (let lx = 1; lx < pW - 1; lx++) {
        const k = ly * pW + lx;
        if (bgMask[k]) continue;
        if (bgMask[k - 1] || bgMask[k + 1] || bgMask[k - pW] || bgMask[k + pW]) {
          const pIdx = (pY0 + ly) * W + (pX0 + lx);
          if (wbLum[pIdx] >= 165) dilated[k] = 1;
        }
      }
    }

    portraitBgAlpha = new Float32Array(pW * pH);
    for (let ly = 0; ly < pH; ly++) {
      for (let lx = 0; lx < pW; lx++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = ly + dy;
          if (ny < 0 || ny >= pH) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = lx + dx;
            if (nx < 0 || nx >= pW) continue;
            sum += dilated[ny * pW + nx];
            cnt++;
          }
        }
        portraitBgAlpha[ly * pW + lx] = sum / cnt;
      }
    }
  }

  const normalized = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pIdx = y * W + x;
      const i = pIdx * 4;
      const rawR = pixels[i], rawG = pixels[i + 1], rawB = pixels[i + 2];
      let r = wbRGB[pIdx * 3];
      let g = wbRGB[pIdx * 3 + 1];
      let b = wbRGB[pIdx * 3 + 2];
      const lum = wbLum[pIdx];

      // Measure 5x5 local surrounding paper brightness to detect fine Bangla vowel arches ('ি', 'ী') and thin strokes
      let locMax = lum;
      let locSum = 0, locCnt = 0;
      for (let dy = -2; dy <= 2; dy += 2) {
        const ny = clamp(y + dy, 0, H - 1) * W;
        for (let dx = -2; dx <= 2; dx += 2) {
          const nl = wbLum[ny + clamp(x + dx, 0, W - 1)];
          if (nl > locMax) locMax = nl;
          locSum += nl;
          locCnt++;
        }
      }
      const locMean = locSum / locCnt;
      // localDip > 0 when this pixel is part of a dark/thin character stroke relative to its immediate neighborhood
      const localDip = Math.max(locMean - lum, (locMax - lum) * 0.65);

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;
      const yel = 0.5 * (r + g) - b;
      const pinkExcess = Math.max(r - g, (rawR - rawG) * 1.15);
      const isPinkRedInk =
        ((r - g >= 11 && r - b >= 6) || (rawR - rawG >= 12 && rawR - rawB >= 7)) &&
        yel < 24 &&
        lum >= 55 &&
        lum < 246;

      if (mode === 'bw') {
        const adjLum = localDip > 3.5 ? lum - localDip * 0.7 : lum;
        const v = adjLum >= 210 ? 255 : adjLum <= 50 ? 0 : Math.round(((adjLum - 50) / 160) * 255);
        r = g = b = v;
      } else {
        // 100% smooth, continuous scanner tone & chroma curve:
        // White point at 224 bleaches all warm paper waves (wbB >= 226) to pure #FFFFFF (255,255,255)
        const pull = localDip > 2.2 ? (localDip - 2.2) * 0.62 : 0;
        const mapLevel = (c) => clamp(((c - pull - 26) / 198) * 255, 0, 255);
        let lr = mapLevel(r);
        let lg = mapLevel(g);
        let lb = mapLevel(b);
        const lLum = 0.299 * lr + 0.587 * lg + 0.114 * lb;

        // Boost chroma only where white-balanced saturation exceeds paper noise (sat > 14)
        const colorW = clamp((sat - 14) / 18, 0, 1) * clamp((lum - 85) / 55, 0, 1);
        const chromaBoost = 1 + 0.38 * colorW;
        lr = clamp(lLum + (lr - lLum) * chromaBoost, 0, 255);
        lg = clamp(lLum + (lg - lLum) * chromaBoost, 0, 255);
        lb = clamp(lLum + (lb - lLum) * chromaBoost, 0, 255);

        // Smooth stroke-aware pink/red ink restoration for camera-glare washed-out pink text ("National ID Card", "04 Dec 2000", "1513301679", "A+")
        const wbPink = Math.max(0, Math.min(r - g, (r - b) * 1.2) - 7);
        if (wbPink > 0 && lum >= 120 && yel < 18) {
          const strokeW = clamp((localDip - 1.2) / 6.5, 0.10, 1.0) * clamp((lum - 120) / 40, 0, 1);
          const pPull = clamp(wbPink * 1.65 * strokeW, 0, 78);
          lr = clamp(lr - pPull * 0.15, 0, 255);
          lg = clamp(lg - pPull * 1.08, 0, 255);
          lb = clamp(lb - pPull * 0.85, 0, 255);
        }

        // Golden-yellow Shapla watermark homogenization (restricted strictly to the Front card's central Shapla circle + top-left Emblem)
        const inShaplaCircle = hasFrontPortrait && Math.hypot((x - W * 0.525) / (W * 0.195), (y - H * 0.60) / (H * 0.285)) <= 1.02;
        const inEmblemBox = hasFrontPortrait && x >= W * 0.015 && x <= W * 0.145 && y >= H * 0.03 && y <= H * 0.23;
        if ((inShaplaCircle || inEmblemBox) && yel > 8 && lum >= 160 && r >= g - 12 && localDip < 10) {
          const yW = clamp((yel - 8) / 14, 0, 0.88) * clamp((lum - 160) / 35, 0, 1) * clamp((10 - localDip) / 5, 0, 1);
          lr = lr * (1 - yW) + 252 * yW;
          lg = lg * (1 - yW) + 241 * yW;
          lb = lb * (1 - yW) + 178 * yW;
        }

        // Clean studio portrait rendering on Front card:
        // - Edge-connected studio background & head shadow (bgA -> 1.0) is bleached to pure #FFFFFF white (zero shadow halo!).
        // - Interior portrait subject (face, forehead, hair, hijab, clothing; bgA -> 0.0) keeps 100% original natural colors.
        if (hasFrontPortrait && portraitBgAlpha && x >= pX0 && x <= pX1 && y >= pY0 && y <= pY1) {
          const lx = x - pX0;
          const ly = y - pY0;
          const bgA = portraitBgAlpha[ly * pW + lx];
          const dxEdge = Math.min(lx, pW - 1 - lx);
          const dyEdge = Math.min(ly, pH - 1 - ly);
          const boxEdgeW = clamp(Math.min(dxEdge, dyEdge) / 6, 0, 1);

          const rawMax = Math.max(1, rawR, rawG, rawB);
          const targetGain = clamp(210 / Math.max(165, medPaperR), 1.0, 1.14);
          const safeGain = Math.min(targetGain, 236 / rawMax);
          const pr = clamp(rawR * safeGain, 0, 242);
          const pg = clamp(rawG * safeGain, 0, 242);
          const pb = clamp(rawB * safeGain, 0, 242);

          // Blend pure #FFFFFF studio background with natural portrait subject
          const cleanR = pr * (1 - bgA) + 255 * bgA;
          const cleanG = pg * (1 - bgA) + 255 * bgA;
          const cleanB = pb * (1 - bgA) + 255 * bgA;

          lr = lr * (1 - boxEdgeW) + cleanR * boxEdgeW;
          lg = lg * (1 - boxEdgeW) + cleanG * boxEdgeW;
          lb = lb * (1 - boxEdgeW) + cleanB * boxEdgeW;
        }

        r = Math.round(lr);
        g = Math.round(lg);
        b = Math.round(lb);
      }

      normalized[i] = r;
      normalized[i + 1] = g;
      normalized[i + 2] = b;
      normalized[i + 3] = 255;
    }
  }

  const sharp = new Uint8ClampedArray(normalized.length);
  sharp.set(normalized);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = normalized[i + c];
        const avgNb = (
          normalized[i - 4 + c] +
          normalized[i + 4 + c] +
          normalized[i - W * 4 + c] +
          normalized[i + W * 4 + c]
        ) * 0.25;
        sharp[i + c] = clamp(Math.round(center + 0.26 * (center - avgNb)), 0, 255);
      }
    }
  }
  return sharp;
}

/**
 * Full automatic pipeline for an uploaded mobile/scanner NID photo.
 */
export async function detectAndProcessNidSide(file, options = {}) {
  const sourceCanvas = await loadOrientedImageCanvas(file);
  const workingCanvas = options.rotationSteps ? rotateCanvas90(sourceCanvas, options.rotationSteps) : sourceCanvas;

  const maxWork = 960;
  const workScale = Math.min(1, maxWork / Math.max(workingCanvas.width, workingCanvas.height));
  const wW = Math.max(40, Math.round(workingCanvas.width * workScale));
  const wH = Math.max(40, Math.round(workingCanvas.height * workScale));

  const workCanvas = document.createElement('canvas');
  workCanvas.width = wW;
  workCanvas.height = wH;
  workCanvas.getContext('2d').drawImage(workingCanvas, 0, 0, wW, wH);
  const workImg = workCanvas.getContext('2d').getImageData(0, 0, wW, wH);

  const corners = options.corners || detectCardCornersFromImageData(workImg.data, wW, wH);
  const showBlackBorder = options.showBlackBorder !== undefined ? options.showBlackBorder : true;
  const scannedCanvas = renderWarpedCardCanvas(workingCanvas, corners, options.enhanceMode || 'scanner', showBlackBorder);

  return {
    sourceCanvas: workingCanvas,
    corners,
    scannedCanvas,
    scannedDataUrl: scannedCanvas.toDataURL('image/jpeg', 0.94)
  };
}

/**
 * Renders the flat strictly cropped rectangular NID scan canvas.
 */
export function renderWarpedCardCanvas(sourceCanvas, corners, enhanceMode = 'scanner', showBlackBorder = true) {
  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const srcImg = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

  const warped = warpCardImageData(
    srcImg.data,
    sourceCanvas.width,
    sourceCanvas.height,
    corners,
    NID_CANVAS_W,
    NID_CANVAS_H,
    showBlackBorder
  );
  const enhanced = applyScannerEnhance(warped, NID_CANVAS_W, NID_CANVAS_H, enhanceMode);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = NID_CANVAS_W;
  outCanvas.height = NID_CANVAS_H;
  const ctx = outCanvas.getContext('2d');
  ctx.putImageData(new ImageData(enhanced, NID_CANVAS_W, NID_CANVAS_H), 0, 0);
  return outCanvas;
}

/**
 * Draws a crisp rectangular flatbed-quality card onto the A4 canvas.
 */
function drawCardOnA4(ctx, cardCanvas, xPx, yPx, wPx, hPx, showCutBorder) {
  ctx.drawImage(cardCanvas, xPx, yPx, wPx, hPx);

  if (showCutBorder) {
    ctx.save();
    ctx.strokeStyle = '#1e2024';
    ctx.lineWidth = 3;
    ctx.strokeRect(xPx, yPx, wPx, hPx);
    ctx.restore();
  }
}

/**
 * Generates a true 300 DPI A4 sheet (2480 x 3508 px) with Front above Back
 * separated by a standardized vertical gap matching the reference flatbed scanner A4 layout.
 */
export function buildPrintReadyA4Canvas({
  frontCanvas = null,
  backCanvas = null,
  scaleFactor = 1.0,
  gapMm = 21,
  showCutBorder = true,
  showHalfGuide = false
}) {
  const pxPerMm = A4_CANVAS_W / A4_WIDTH_MM;
  const a4 = document.createElement('canvas');
  a4.width = A4_CANVAS_W;
  a4.height = A4_CANVAS_H;
  const ctx = a4.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, A4_CANVAS_W, A4_CANVAS_H);

  const cardW = Math.round(CR80_WIDTH_MM * scaleFactor * pxPerMm);
  const cardH = Math.round(CR80_HEIGHT_MM * scaleFactor * pxPerMm);
  const gapPx = Math.round(gapMm * pxPerMm);
  const centerX = Math.round((A4_CANVAS_W - cardW) / 2);

  const midY = Math.round(A4_CANVAS_H * 0.4665);
  const halfY = Math.round(A4_CANVAS_H / 2);
  const topY = midY - Math.round(gapPx / 2) - cardH;
  const botY = midY + Math.round(gapPx / 2);

  if (showHalfGuide) {
    ctx.save();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(Math.round(18 * pxPerMm), halfY);
    ctx.lineTo(A4_CANVAS_W - Math.round(18 * pxPerMm), halfY);
    ctx.stroke();
    ctx.restore();
  }

  if (frontCanvas) {
    drawCardOnA4(ctx, frontCanvas, centerX, topY, cardW, cardH, showCutBorder);
  }
  if (backCanvas) {
    drawCardOnA4(ctx, backCanvas, centerX, botY, cardW, cardH, showCutBorder);
  }

  return a4;
}

/**
 * Exports a genuine 210mm x 297mm (595.28 x 841.89 pt) print-ready A4 PDF Blob.
 */
export function buildA4PdfBlob(a4Canvas) {
  const dataUrl = a4Canvas.toDataURL('image/jpeg', 0.95);
  const base64 = dataUrl.split(',')[1];
  const binStr = atob(base64);
  const jpgBytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) jpgBytes[i] = binStr.charCodeAt(i);

  const enc = new TextEncoder();
  const ptW = '595.28';
  const ptH = '841.89';
  const streamCmd = `q ${ptW} 0 0 ${ptH} 0 0 cm /Im1 Do Q`;

  const chunks = [];
  const offsets = [];
  let cursor = 0;

  const pushStr = (s) => {
    const b = enc.encode(s);
    chunks.push(b);
    cursor += b.length;
  };
  const pushBytes = (b) => {
    chunks.push(b);
    cursor += b.length;
  };

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  offsets[1] = cursor;
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = cursor;
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  offsets[3] = cursor;
  pushStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

  offsets[4] = cursor;
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${a4Canvas.width} /Height ${a4Canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpgBytes.length} >>\nstream\n`
  );
  pushBytes(jpgBytes);
  pushStr('\nendstream\nendobj\n');

  offsets[5] = cursor;
  pushStr(`5 0 obj\n<< /Length ${streamCmd.length} >>\nstream\n${streamCmd}\nendstream\nendobj\n`);

  const xrefOffset = cursor;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let id = 1; id <= 5; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pushStr(xref);
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const out = new Uint8Array(cursor);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return new Blob([out], { type: 'application/pdf' });
}
