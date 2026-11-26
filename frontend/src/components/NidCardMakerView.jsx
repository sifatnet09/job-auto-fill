import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  detectAndProcessNidSide,
  renderWarpedCardCanvas,
  rotateCanvas90,
  orderQuadCorners,
  buildPrintReadyA4Canvas,
  buildA4PdfBlob,
  CR80_WIDTH_MM,
  CR80_HEIGHT_MM
} from '../services/nidScanner.js';

const CORNER_LABELS = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left'];

function SideUploader({
  sideKey,
  title,
  badgeText,
  state,
  onSelectFile,
  onRotate,
  onCornersChange,
  onResetSide
}) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const svgRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [editingCorners, setEditingCorners] = useState(false);
  const [activeCorner, setActiveCorner] = useState(-1);

  const handleFilePick = (file) => {
    if (!file) return;
    setEditingCorners(false);
    onSelectFile(sideKey, file);
  };

  const handlePointerMove = (e) => {
    if (activeCorner < 0 || !svgRef.current || !state?.corners) return;
    const rect = svgRef.current.getBoundingClientRect();
    const nx = Math.min(0.99, Math.max(0.01, (e.clientX - rect.left) / rect.width));
    const ny = Math.min(0.99, Math.max(0.01, (e.clientY - rect.top) / rect.height));
    const next = state.corners.map((c, idx) => (idx === activeCorner ? { x: nx, y: ny } : c));
    onCornersChange(sideKey, next);
  };

  const stopDrag = () => setActiveCorner(-1);

  const polyPoints = (state?.corners || [])
    .map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
    .join(' ');

  return (
    <div className="panel nid-side-panel">
      <div className="panel-header">
        <div className="panel-title-group">
          <div className={`panel-icon-badge ${sideKey === 'front' ? 'badge-emerald' : 'badge-indigo'}`}>
            <i className={`fa-solid ${sideKey === 'front' ? 'fa-id-card' : 'fa-barcode'}`}></i>
          </div>
          <div>
            <h2>{title}</h2>
            <span className="panel-subtitle">{badgeText}</span>
          </div>
        </div>
        {state?.scannedDataUrl && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`btn btn-sm ${editingCorners ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setEditingCorners((v) => !v)}
              title="Fine-tune detected card corners"
            >
              <i className="fa-solid fa-vector-square"></i> {editingCorners ? 'Done' : 'Adjust'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => onRotate(sideKey)}
              title="Rotate 90° clockwise"
            >
              <i className="fa-solid fa-rotate-right"></i>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline text-danger"
              onClick={() => {
                setEditingCorners(false);
                onResetSide(sideKey);
              }}
              title="Clear image"
            >
              <i className="fa-solid fa-trash"></i>
            </button>
          </div>
        )}
      </div>

      <div className="panel-body">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.[0]) handleFilePick(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.[0]) handleFilePick(e.target.files[0]);
            e.target.value = '';
          }}
        />

        {!state?.scannedDataUrl ? (
          <div
            className={`drop-zone nid-drop-zone ${dragOver ? 'dragover' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.[0]) handleFilePick(e.dataTransfer.files[0]);
            }}
          >
            {state?.processing ? (
              <div className="parse-status-box" style={{ margin: 0, border: 'none', background: 'transparent' }}>
                <div className="spinner"></div>
                <div>Detecting card edges &amp; flattening...</div>
              </div>
            ) : (
              <>
                <i className="fa-solid fa-id-card-clip drop-icon" style={{ fontSize: 32 }}></i>
                <div className="drop-text">
                  <strong>Upload or Drop NID {sideKey === 'front' ? 'Front' : 'Back'} Image</strong>
                  <span>Auto-crops clutter, fixes tilt &amp; enhances to scanner quality</span>
                </div>
                <div className="nid-upload-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => fileRef.current?.click()}>
                    <i className="fa-solid fa-image"></i> Choose Photo
                  </button>
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => cameraRef.current?.click()}>
                    <i className="fa-solid fa-camera"></i> Mobile Camera
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
            {editingCorners && state.sourceDataUrl ? (
              <div
                className="nid-corner-editor"
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerLeave={stopDrag}
              >
                <img src={state.sourceDataUrl} alt={`Raw ${sideKey}`} className="nid-corner-raw-img" />
                <svg ref={svgRef} viewBox="0 0 100 100" preserveAspectRatio="none" className="nid-corner-svg">
                  <polygon points={polyPoints} fill="rgba(16, 185, 129, 0.16)" stroke="#10b981" strokeWidth="0.9" />
                  {(state.corners || []).map((pt, idx) => (
                    <circle
                      key={CORNER_LABELS[idx]}
                      cx={pt.x * 100}
                      cy={pt.y * 100}
                      r="3.2"
                      fill="#059669"
                      stroke="#ffffff"
                      strokeWidth="1"
                      style={{ cursor: 'grab' }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setActiveCorner(idx);
                      }}
                    >
                      <title>{CORNER_LABELS[idx]}</title>
                    </circle>
                  ))}
                </svg>
                <div className="nid-corner-hint">Drag green corners onto exact NID card edges, then click Done</div>
              </div>
            ) : (
              <div className="nid-scanned-preview-wrap">
                <img src={state.scannedDataUrl} alt={`Scanned NID ${sideKey}`} className="nid-scanned-preview-img" />
              </div>
            )}

            <div className="nid-side-footer">
              <span className="badge badge-success">
                <i className="fa-solid fa-check"></i> Perspective Flattened
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => fileRef.current?.click()}>
                  <i className="fa-solid fa-upload"></i> Replace
                </button>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => cameraRef.current?.click()}>
                  <i className="fa-solid fa-camera"></i> Camera
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function NidCardMakerView({ showToast }) {
  const [front, setFront] = useState(null);
  const [back, setBack] = useState(null);
  const [enhanceMode, setEnhanceMode] = useState('scanner');
  const [scaleFactor, setScaleFactor] = useState(1.0);
  const [gapMm, setGapMm] = useState(21);
  const [showCutBorder, setShowCutBorder] = useState(true);
  const [showHalfGuide, setShowHalfGuide] = useState(false);
  const [a4PreviewUrl, setA4PreviewUrl] = useState('');
  const a4CanvasRef = useRef(null);

  const getSetter = (side) => (side === 'front' ? setFront : setBack);

  const handleSelectFile = async (side, file) => {
    const setter = getSetter(side);
    setter({ processing: true });
    try {
      const result = await detectAndProcessNidSide(file, { enhanceMode, showBlackBorder: showCutBorder });
      setter({
        processing: false,
        sourceCanvas: result.sourceCanvas,
        sourceDataUrl: result.sourceCanvas.toDataURL('image/jpeg', 0.85),
        corners: result.corners,
        scannedCanvas: result.scannedCanvas,
        scannedDataUrl: result.scannedDataUrl
      });
      showToast(`NID ${side === 'front' ? 'Front' : 'Back'} scanned & perspective corrected!`);
    } catch (err) {
      setter(null);
      alert(`Failed to process ${side} image: ${err.message}`);
    }
  };

  const reRenderSide = useCallback((sideState, nextMode, nextBorder = showCutBorder) => {
    if (!sideState?.sourceCanvas || !sideState?.corners) return sideState;
    const scannedCanvas = renderWarpedCardCanvas(sideState.sourceCanvas, sideState.corners, nextMode, nextBorder);
    return {
      ...sideState,
      scannedCanvas,
      scannedDataUrl: scannedCanvas.toDataURL('image/jpeg', 0.94)
    };
  }, [showCutBorder]);

  const handleEnhanceChange = (mode) => {
    setEnhanceMode(mode);
    setFront((prev) => reRenderSide(prev, mode, showCutBorder));
    setBack((prev) => reRenderSide(prev, mode, showCutBorder));
  };

  const handleBlackBorderChange = (nextBorder) => {
    setShowCutBorder(nextBorder);
    setFront((prev) => reRenderSide(prev, enhanceMode, nextBorder));
    setBack((prev) => reRenderSide(prev, enhanceMode, nextBorder));
  };

  const handleRotate = (side) => {
    const setter = getSetter(side);
    setter((prev) => {
      if (!prev?.sourceCanvas) return prev;
      const rotatedSource = rotateCanvas90(prev.sourceCanvas, 1);
      const rotatedCorners = orderQuadCorners((prev.corners || []).map((p) => ({ x: 1 - p.y, y: p.x })));
      const scannedCanvas = renderWarpedCardCanvas(rotatedSource, rotatedCorners, enhanceMode, showCutBorder);
      return {
        ...prev,
        sourceCanvas: rotatedSource,
        sourceDataUrl: rotatedSource.toDataURL('image/jpeg', 0.85),
        corners: rotatedCorners,
        scannedCanvas,
        scannedDataUrl: scannedCanvas.toDataURL('image/jpeg', 0.94)
      };
    });
  };

  const handleCornersChange = (side, nextCorners) => {
    const setter = getSetter(side);
    setter((prev) => {
      if (!prev?.sourceCanvas) return prev;
      const scannedCanvas = renderWarpedCardCanvas(prev.sourceCanvas, nextCorners, enhanceMode, showCutBorder);
      return {
        ...prev,
        corners: nextCorners,
        scannedCanvas,
        scannedDataUrl: scannedCanvas.toDataURL('image/jpeg', 0.94)
      };
    });
  };

  const handleResetSide = (side) => {
    getSetter(side)(null);
  };

  useEffect(() => {
    if (!front?.scannedCanvas && !back?.scannedCanvas) {
      a4CanvasRef.current = null;
      setA4PreviewUrl('');
      return;
    }
    const a4 = buildPrintReadyA4Canvas({
      frontCanvas: front?.scannedCanvas || null,
      backCanvas: back?.scannedCanvas || null,
      scaleFactor,
      gapMm,
      showCutBorder,
      showHalfGuide
    });
    a4CanvasRef.current = a4;
    setA4PreviewUrl(a4.toDataURL('image/jpeg', 0.92));
  }, [front, back, scaleFactor, gapMm, showCutBorder, showHalfGuide]);

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleDownloadPdf = () => {
    if (!a4CanvasRef.current) return;
    const pdfBlob = buildA4PdfBlob(a4CanvasRef.current);
    downloadBlob(pdfBlob, `NID_A4_Print_${Date.now()}.pdf`);
    showToast('Print-ready A4 PDF downloaded (210 × 297 mm)!');
  };

  const handleDownloadPng = () => {
    if (!a4CanvasRef.current) return;
    a4CanvasRef.current.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `NID_A4_300DPI_${Date.now()}.png`);
        showToast('High-resolution A4 PNG (300 DPI) downloaded!');
      }
    }, 'image/png');
  };

  const handlePrintA4 = () => {
    if (!a4PreviewUrl) return;
    window.print();
  };

  const printWidthMm = (CR80_WIDTH_MM * scaleFactor).toFixed(1);
  const printHeightMm = (CR80_HEIGHT_MM * scaleFactor).toFixed(1);

  return (
    <section id="view-nid-maker" className="content-view active">
      <div className="view-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>NID Card Maker (Auto Scanner &amp; A4 Print)</h1>
            <span
              className="badge badge-success"
              style={{ fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="All image processing, cropping, colour enhancement, and PDF generation run 100% locally in your browser memory. Nothing is ever sent to any server or database."
            >
              <i className="fa-solid fa-shield-halved"></i> 100% Browser Render • No Database Upload
            </span>
          </div>
          <p style={{ marginTop: 6 }}>Capture or upload Bangladeshi NID front &amp; back photos — processed 100% locally in your browser (never uploaded to database or server) to auto-detect card edges, flatten tilt, and format a 300 DPI A4 print sheet.</p>
        </div>
        {(front?.scannedCanvas || back?.scannedCanvas) && (
          <div className="header-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-outline text-danger"
              onClick={() => {
                setFront(null);
                setBack(null);
                a4CanvasRef.current = null;
                setA4PreviewUrl('');
                showToast('Cleared all NID images from browser memory!');
              }}
              title="Clear all NID images from browser memory"
            >
              <i className="fa-solid fa-broom"></i> Clear Memory
            </button>
            <button type="button" className="btn btn-outline" onClick={handleDownloadPng}>
              <i className="fa-solid fa-file-image"></i> Download A4 PNG
            </button>
            <button type="button" className="btn btn-primary" onClick={handleDownloadPdf}>
              <i className="fa-solid fa-file-pdf"></i> Download Print A4 PDF
            </button>
            <button type="button" className="btn btn-primary" style={{ background: '#1d4ed8' }} onClick={handlePrintA4}>
              <i className="fa-solid fa-print"></i> Print A4 Now
            </button>
          </div>
        )}
      </div>

      {/* Dual Upload Cards: Front & Back */}
      <div className="nid-dual-grid">
        <SideUploader
          sideKey="front"
          title="1. NID Front Side"
          badgeText={`Placed top with crisp ${gapMm} mm standardized flatbed gap`}
          state={front}
          onSelectFile={handleSelectFile}
          onRotate={handleRotate}
          onCornersChange={handleCornersChange}
          onResetSide={handleResetSide}
        />
        <SideUploader
          sideKey="back"
          title="2. NID Back Side"
          badgeText="Placed directly below front — flat rectangular scan"
          state={back}
          onSelectFile={handleSelectFile}
          onRotate={handleRotate}
          onCornersChange={handleCornersChange}
          onResetSide={handleResetSide}
        />
      </div>

      {/* Print Controls & Live A4 Sheet Preview */}
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <div className="panel-title-group">
            <div className="panel-icon-badge"><i className="fa-solid fa-print"></i></div>
            <div>
              <h2>Print-Ready A4 Preview (210 mm × 297 mm)</h2>
              <span className="panel-subtitle">
                Printed card dimensions: <strong>{printWidthMm} mm × {printHeightMm} mm</strong> ({scaleFactor === 1 ? 'Exact CR80 Smart NID 1:1 physical size' : 'Enlarged shop photocopy size'})
              </span>
            </div>
          </div>

          <div className="nid-toolbar">
            <label className="nid-control-chip">
              <span>Enhance:</span>
              <select className="form-control" style={{ padding: '4px 8px', width: 'auto' }} value={enhanceMode} onChange={(e) => handleEnhanceChange(e.target.value)}>
                <option value="scanner">Auto Scanner Clean</option>
                <option value="original">Original Color</option>
                <option value="bw">High-Contrast B&amp;W</option>
              </select>
            </label>

            <label className="nid-control-chip">
              <span>Card Size:</span>
              <select className="form-control" style={{ padding: '4px 8px', width: 'auto' }} value={scaleFactor} onChange={(e) => setScaleFactor(Number(e.target.value))}>
                <option value={1.0}>Actual Size (85.6 × 54 mm)</option>
                <option value={1.2}>Large Photocopy (103 × 65 mm)</option>
              </select>
            </label>

            <label className="nid-control-chip">
              <span>Gap:</span>
              <select className="form-control" style={{ padding: '4px 8px', width: 'auto' }} value={gapMm} onChange={(e) => setGapMm(Number(e.target.value))}>
                <option value={8}>8 mm (Tight)</option>
                <option value={10}>10 mm (Compact)</option>
                <option value={14}>14 mm (Medium)</option>
                <option value={21}>21 mm (Standard A4)</option>
              </select>
            </label>

            <label
              className="nid-checkbox-chip"
              style={{
                background: showCutBorder ? '#0f172a' : '#f1f5f9',
                color: showCutBorder ? '#ffffff' : '#334155',
                borderColor: showCutBorder ? '#0f172a' : '#cbd5e1',
                fontWeight: 600
              }}
              title="Turn Black Border ON or OFF around both NID cards"
            >
              <input
                type="checkbox"
                checked={showCutBorder}
                onChange={(e) => handleBlackBorderChange(e.target.checked)}
              />
              <span>Black Border: {showCutBorder ? 'ON' : 'OFF'}</span>
            </label>

            <label className="nid-checkbox-chip">
              <input type="checkbox" checked={showHalfGuide} onChange={(e) => setShowHalfGuide(e.target.checked)} />
              <span>Cut Guide</span>
            </label>
          </div>
        </div>

        <div className="panel-body">
          {!a4PreviewUrl ? (
            <div className="nid-a4-empty">
              <i className="fa-regular fa-file-lines" style={{ fontSize: 34, color: '#94a3b8', marginBottom: 8 }}></i>
              <strong>Upload NID Front &amp; Back photos above to generate your A4 print sheet</strong>
              <span className="text-muted">Front &amp; Back stack vertically on A4 with a clean {gapMm} mm flatbed scanner gap.</span>
            </div>
          ) : (
            <div className="nid-a4-stage">
              <div className="nid-a4-sheet-frame">
                <img src={a4PreviewUrl} alt="Print-ready A4 NID Sheet" className="nid-a4-preview-img" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dedicated clean printable A4 container shown ONLY during window.print() */}
      {a4PreviewUrl && (
        <div id="nid-a4-print-root">
          <img src={a4PreviewUrl} alt="NID Print Sheet" />
        </div>
      )}
    </section>
  );
}
