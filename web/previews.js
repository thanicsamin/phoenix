// PDF.js is loaded only for a visible PDF. One first page is rendered at a time
// on the owner's device; the server only streams the original protected file.
let pdfjs;
let rendering = Promise.resolve();
const thumbnails = new Map();
async function thumbnail(url) {
  if (thumbnails.has(url)) return thumbnails.get(url);
  pdfjs ||= import('/vendor/pdfjs/pdf.mjs');
  const library = await pdfjs;
  library.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  const task = library.getDocument({ url, isEvalSupported: false, disableFontFace: true, useSystemFonts: true, disableRange: true,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, wasmUrl: '/vendor/pdfjs/wasm/' });
  const timeout = setTimeout(() => task.destroy(), 20000);
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(480 / original.width, 480 / original.height) });
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .8));
    if (!blob) throw Error('Preview unavailable');
    const image = URL.createObjectURL(blob); thumbnails.set(url, image);
    if (thumbnails.size > 20) { const first = thumbnails.keys().next().value; URL.revokeObjectURL(thumbnails.get(first)); thumbnails.delete(first); }
    return image;
  } finally { clearTimeout(timeout); await task.destroy(); }
}
const visible = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) if (isIntersecting) {
    visible.unobserve(target);
    rendering = rendering.then(async () => {
      if (!target.isConnected) return;
      try { const image = await thumbnail(target.dataset.pdf); if (target.isConnected) target.src = image; }
      catch { target.alt = 'PDF'; target.closest('a').title = 'Preview unavailable · Download PDF'; }
    }).catch(() => {});
  }
});
window.previewPDF = (image, url) => { image.dataset.pdf = url; image.alt = 'PDF'; visible.observe(image); };
window.resetPreviews = (clear = false) => {
  visible.disconnect();
  if (clear) { for (const url of thumbnails.values()) URL.revokeObjectURL(url); thumbnails.clear(); }
};
