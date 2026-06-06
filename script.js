import { removeBackground } from 'https://esm.sh/@imgly/background-removal@1.4.5';

// Initialize memoize from global lodash
const memoize = typeof _ !== 'undefined' ? _.memoize : (fn) => fn;
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const upload = document.getElementById('upload');
const fileNameDisplay = document.getElementById('fileName');
const zoomSlider = document.getElementById('zoom');
const moveXSlider = document.getElementById('moveX');
const moveYSlider = document.getElementById('moveY');
const bgColor = document.getElementById('bgColor');
const copiesInput = document.getElementById('copies');
const printBtn = document.getElementById('printBtn');
const removeBgToggle = document.getElementById('removeBg');

const PASSPORT_WIDTH_MM = 35;
const PASSPORT_HEIGHT_MM = 45;
const PRINT_DPI = 300;
const MM_PER_INCH = 25.4;
const PASSPORT_PRINT_WIDTH_PX = Math.round((PASSPORT_WIDTH_MM / MM_PER_INCH) * PRINT_DPI);
const PASSPORT_PRINT_HEIGHT_PX = Math.round((PASSPORT_HEIGHT_MM / MM_PER_INCH) * PRINT_DPI);

// Value indicators
const zoomVal = document.getElementById('zoomVal');
const moveXVal = document.getElementById('moveXVal');
const moveYVal = document.getElementById('moveYVal');

// Loading overlay
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');

let originalFile = null; 
let originalDataUrl = null;
let noBgImageBlobUrl = null;
let currentWorkingUrl = null;
let originalWidth, originalHeight;

let img = new Image();
let maskImg = new Image();
let offscreenCanvas = null; // Used for pre-compositing the AI mask to avoid heavy re-renders
let imgLoaded = false;
let maskLoaded = false;
let zoom = 1;
let moveX = 0;
let moveY = 0;

let drawAnimationFrame = null;
let isProcessingAI = false; // Lock to prevent race conditions during rapid toggles

const dpr = window.devicePixelRatio || 1;

function setPassportCanvasSize() {
  canvas.style.width = `${PASSPORT_PRINT_WIDTH_PX}px`;
  canvas.style.height = 'auto';
  canvas.width = Math.round(PASSPORT_PRINT_WIDTH_PX * dpr);
  canvas.height = Math.round(PASSPORT_PRINT_HEIGHT_PX * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  console.log('Passport canvas locked:', PASSPORT_WIDTH_MM, 'x', PASSPORT_HEIGHT_MM, 'mm at', PASSPORT_PRINT_WIDTH_PX, 'x', PASSPORT_PRINT_HEIGHT_PX, 'px');
}

setPassportCanvasSize();

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

async function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = (error) => {
      URL.revokeObjectURL(objectUrl);
      reject(error);
    };
    image.src = objectUrl;
  });
}

async function applyEdgeFeathering(blob) {
  const image = await loadImageFromBlob(blob);
  const width = image.width;
  const height = image.height;

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceCtx = sourceCanvas.getContext('2d');
  sourceCtx.imageSmoothingEnabled = true;
  sourceCtx.imageSmoothingQuality = 'high';
  sourceCtx.clearRect(0, 0, width, height);
  sourceCtx.drawImage(image, 0, 0, width, height);

  // Extract alpha channel into a grayscale mask.
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = width;
  alphaCanvas.height = height;
  const alphaCtx = alphaCanvas.getContext('2d');
  alphaCtx.imageSmoothingEnabled = true;
  alphaCtx.imageSmoothingQuality = 'high';

  const sourceData = sourceCtx.getImageData(0, 0, width, height);
  const alphaData = alphaCtx.createImageData(width, height);
  for (let i = 0; i < sourceData.data.length; i += 4) {
    const alpha = sourceData.data[i + 3];
    alphaData.data[i] = alpha;
    alphaData.data[i + 1] = alpha;
    alphaData.data[i + 2] = alpha;
    alphaData.data[i + 3] = alpha;
  }
  alphaCtx.putImageData(alphaData, 0, 0);

  // Blur only the alpha edge to soften the mask transition.
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = width;
  blurCanvas.height = height;
  const blurCtx = blurCanvas.getContext('2d');
  blurCtx.imageSmoothingEnabled = true;
  blurCtx.imageSmoothingQuality = 'high';
  blurCtx.filter = 'blur(1.5px)';
  blurCtx.drawImage(alphaCanvas, 0, 0, width, height);
  blurCtx.filter = 'none';

  // Composite the original subject over a white background, then apply the softened alpha mask.
  const resultCanvas = document.createElement('canvas');
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultCtx = resultCanvas.getContext('2d');
  resultCtx.imageSmoothingEnabled = true;
  resultCtx.imageSmoothingQuality = 'high';

  resultCtx.fillStyle = '#FFFFFF';
  resultCtx.fillRect(0, 0, width, height);
  resultCtx.drawImage(sourceCanvas, 0, 0, width, height);
  resultCtx.globalCompositeOperation = 'destination-in';
  resultCtx.drawImage(blurCanvas, 0, 0, width, height);
  resultCtx.globalCompositeOperation = 'source-over';

  return new Promise((resolve) => {
    resultCanvas.toBlob((featheredBlob) => {
      resolve(featheredBlob);
    }, 'image/png', 1.0);
  });
}

function loadMaskImage(url) {
  return new Promise((resolve, reject) => {
    maskImg.onload = () => {
      maskLoaded = true;
      resolve();
    };
    maskImg.onerror = (error) => {
      maskLoaded = false;
      reject(error);
    };
    maskImg.src = url;
  });
}

// Optimization: Pre-composite original image and AI mask into an off-screen canvas once
function createOffscreenComposite() {
  if (!imgLoaded || !maskLoaded) return;
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = img.width;
  offscreenCanvas.height = img.height;
  
  const offCtx = offscreenCanvas.getContext('2d');
  offCtx.imageSmoothingEnabled = true;
  offCtx.imageSmoothingQuality = 'high';
  
  // Draw original image
  offCtx.drawImage(img, 0, 0, img.width, img.height);
  
  // Apply mask
  offCtx.globalCompositeOperation = 'destination-in';
  offCtx.drawImage(maskImg, 0, 0, img.width, img.height);
  
  // Reset operation
  offCtx.globalCompositeOperation = 'source-over';
  console.log('Offscreen composite created successfully for efficient rendering');
}

// Manual model fetcher to bypass library's internal path logic
async function fetchModelManually(modelUrl) {
  console.log('Fetching model manually from:', modelUrl);
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch model: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  console.log('Model fetched successfully, size:', arrayBuffer.byteLength, 'bytes');
  return arrayBuffer;
}

async function updateDisplay() {
  if (!originalDataUrl) return;

  // Always load the original image first to avoid blank canvas
  currentWorkingUrl = originalDataUrl;
  await loadImgScaleAuto(currentWorkingUrl);

  if (removeBgToggle.checked) {
    if (noBgImageBlobUrl) {
      await loadMaskImage(noBgImageBlobUrl);
      createOffscreenComposite();
    } else {
      if (isProcessingAI) return; // Prevent multiple jobs from spawning
      isProcessingAI = true;

      // Process AI in background
      showLoading("AI removing background...");
      try {
        console.log('Starting AI background removal process...');
        console.log('Processing high-resolution image:', originalWidth, 'x', originalHeight, 'pixels');

        const removalOptions = {
          model: 'medium',
          alphaMatting: true,
          alphaMattingForegroundThreshold: 230,
          alphaMattingBackgroundThreshold: 15,
          alphaMattingErodeSize: 1,
          highPassFilter: false,
          progress: (key, current, total) => {
            const perc = Math.round((current / total) * 100);
            if (perc > 0) loadingText.textContent = `Processing AI... ${perc}%`;
          }
        };

        let blob;
        // Try direct initialization first
        try {
          blob = await removeBackground(originalFile, removalOptions);
          console.log('AI processing completed successfully with direct initialization.');
        } catch (directError) {
          console.warn('Direct initialization failed:', directError);
          console.log('Attempting manual model fetch from CDN...');

          // Fallback: Manually fetch model from CDN
          const modelUrl = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal-data@1.4.5/dist/isnet.onnx';
          const modelData = await fetchModelManually(modelUrl);

          console.log('Retrying with manually fetched model...');
          blob = await removeBackground(originalFile, {
            ...removalOptions,
            model: modelData
          });
          console.log('AI processing completed successfully with manual model.');
        }

        const featheredBlob = await applyEdgeFeathering(blob);

        // Clear existing blob URL to prevent memory leaks
        if (noBgImageBlobUrl) {
          URL.revokeObjectURL(noBgImageBlobUrl);
        }

        noBgImageBlobUrl = URL.createObjectURL(featheredBlob);
        await loadMaskImage(noBgImageBlobUrl);
        createOffscreenComposite(); // Generate optimized mask
        console.log('Background removed mask loaded on canvas.');
      } catch (e) {
        console.error("BG Removal Error:", e);
        alert("AI processing failed. Showing original. Please check your internet connection and try again.");
        removeBgToggle.checked = false;
        currentWorkingUrl = originalDataUrl;
        // Original is already loaded, no need to reload
      } finally {
        isProcessingAI = false;
        hideLoading();
      }
    }
  }

  scheduleDraw();
}

function setCanvasBackground() {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  if (bgColor.value !== 'transparent') {
    ctx.fillStyle = bgColor.value;
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  }
}

function updateValuesDisplay() {
  zoomVal.textContent = zoom.toFixed(2) + 'x';
  moveXVal.textContent = moveX + 'px';
  moveYVal.textContent = moveY + 'px';
}

function drawCanvas() {
  setCanvasBackground();

  if (!imgLoaded) return;

  const dpr = window.devicePixelRatio || 1;
  const canvasDisplayWidth = canvas.width / dpr;
  const canvasDisplayHeight = canvas.height / dpr;

  const scaledW = img.width * zoom;
  const scaledH = img.height * zoom;

  const x = (canvasDisplayWidth - scaledW) / 2 + moveX;
  const y = (canvasDisplayHeight - scaledH) / 2 + moveY;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = 'contrast(1.05) brightness(1.02) saturate(1.1)';

  // Optimization: use the pre-generated composite canvas instead of doing it every frame
  if (removeBgToggle.checked && maskLoaded && offscreenCanvas) {
    ctx.drawImage(offscreenCanvas, x, y, scaledW, scaledH);
  } else {
    ctx.drawImage(img, x, y, scaledW, scaledH);
  }

  ctx.restore();
}

function scheduleDraw() {
  if (drawAnimationFrame) {
    cancelAnimationFrame(drawAnimationFrame);
  }
  drawAnimationFrame = requestAnimationFrame(() => {
    updateValuesDisplay();
    drawCanvas();
  });
}

function loadImgScaleAuto(url) {
  return new Promise((resolve, reject) => {
    img.onload = () => {
      // Logic fix: Allow redraw even if already loaded to handle toggles
      if (!imgLoaded) {
        const dpr = window.devicePixelRatio || 1;
        const canvasDisplayHeight = canvas.height / dpr;
        const scaleFit = canvasDisplayHeight / img.height;
        zoomSlider.value = (scaleFit * 0.9).toFixed(2);
        zoom = parseFloat(zoomSlider.value);
        moveX = 0;
        moveY = 0;
        moveXSlider.value = 0;
        moveYSlider.value = 0;
        imgLoaded = true;
        console.log('Image loaded for display. Scale fit ratio:', scaleFit.toFixed(2));
      }
      scheduleDraw();
      resolve();
    };
    img.onerror = (e) => {
      console.error("Failed to load image into canvas:", e);
      reject(new Error("Image rendering failed"));
    };
    img.src = url;
  });
}

// Event Listeners

upload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Validation: Check if the file is an image
  if (!file.type.startsWith('image/')) {
    alert("Please upload a valid image file");
    return;
  }

  showLoading("Reading file...");
  fileNameDisplay.textContent = file.name;
  
  imgLoaded = false;
  maskLoaded = false;
  offscreenCanvas = null; // reset composite
  originalFile = file;
  
  if (noBgImageBlobUrl) {
    URL.revokeObjectURL(noBgImageBlobUrl);
  }
  noBgImageBlobUrl = null;
  maskImg.src = '';
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      originalDataUrl = event.target.result;
      
      // Capture original image dimensions for high-res processing
      const tempImg = new Image();
      tempImg.onload = async () => {
        originalWidth = tempImg.naturalWidth;
        originalHeight = tempImg.naturalHeight;
        console.log('Original image dimensions:', originalWidth, 'x', originalHeight, 'pixels');
        setPassportCanvasSize();
        await updateDisplay();
      };
      tempImg.src = originalDataUrl;
    } catch (err) {
      console.error("Display Error:", err);
      alert("Error displaying image.");
    } finally {
      hideLoading();
    }
  };
  reader.onerror = () => {
    alert("Could not read file.");
    hideLoading();
  };
  reader.readAsDataURL(file);
});

removeBgToggle.addEventListener('change', async () => {
  await updateDisplay();
});

zoomSlider.addEventListener('input', () => {
  zoom = parseFloat(zoomSlider.value);
  scheduleDraw();
});

zoomSlider.addEventListener('dblclick', () => {
  zoomSlider.value = 1;
  zoom = 1;
  scheduleDraw();
});

moveXSlider.addEventListener('input', () => {
  moveX = parseInt(moveXSlider.value);
  scheduleDraw();
});

moveXSlider.addEventListener('dblclick', () => {
  moveXSlider.value = 0;
  moveX = 0;
  scheduleDraw();
});

moveYSlider.addEventListener('input', () => {
  moveY = parseInt(moveYSlider.value);
  scheduleDraw();
});

moveYSlider.addEventListener('dblclick', () => {
  moveYSlider.value = 0;
  moveY = 0;
  scheduleDraw();
});

bgColor.addEventListener('change', scheduleDraw);

canvas.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 2;

    if (e.key === 'ArrowLeft') moveX -= step;
    if (e.key === 'ArrowRight') moveX += step;
    if (e.key === 'ArrowUp') moveY -= step;
    if (e.key === 'ArrowDown') moveY += step;

    moveXSlider.value = moveX;
    moveYSlider.value = moveY;
    scheduleDraw();
  }
});

printBtn.addEventListener('click', () => {
  if (!imgLoaded) {
    alert("Please upload a photo first");
    return;
  }

  const copies = parseInt(copiesInput.value) || 8;
  
  // Export at exactly 300 DPI for a 35mm x 45mm passport photo.
  const printCanvas = document.createElement('canvas');
  printCanvas.width = PASSPORT_PRINT_WIDTH_PX;
  printCanvas.height = PASSPORT_PRINT_HEIGHT_PX;
  const printCtx = printCanvas.getContext('2d');
  printCtx.imageSmoothingEnabled = true;
  printCtx.imageSmoothingQuality = 'high';
  printCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, printCanvas.width, printCanvas.height);

  // Optimization: use toBlob to prevent massive base64 string allocations and browser crashes
  printCanvas.toBlob((blob) => {
    const photoUrl = URL.createObjectURL(blob);
    console.log('Exact passport export:', PASSPORT_WIDTH_MM, 'x', PASSPORT_HEIGHT_MM, 'mm at', printCanvas.width, 'x', printCanvas.height, 'pixels');
    
    let photos = '';
    for (let i = 0; i < copies; i++) {
      photos += `<div class="photo-container"><img src="${photoUrl}" class="photo" alt="Passport Photo"></div>`;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert("Popup blocked. Please allow popups for this site to print.");
      URL.revokeObjectURL(photoUrl);
      return;
    }

    printWindow.document.write(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Print Passport Photos</title>
        <style>
          html, body { margin: 0; padding: 0; background: white; font-family: sans-serif; }
          body { width: 210mm; min-height: 297mm; }
          .sheet { padding: 15mm; display: grid; grid-template-columns: repeat(4, 35mm); grid-auto-rows: 45mm; gap: 5mm; align-content: start; justify-content: start; }
          .photo-container { position: relative; width: 35mm; height: 45mm; box-sizing: border-box; overflow: hidden; outline: 0.2mm solid rgba(0, 0, 0, 0.4); }
          .photo { position: absolute; inset: 0; width: 35mm; height: 45mm; max-width: none; max-height: none; display: block; object-fit: fill; image-rendering: high-quality; }
          @media print { 
            html, body { width: 210mm; height: 297mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; } 
            @page { size: A4 portrait; margin: 0; } 
          }
        </style>
      </head>
      <body>
        <div class="sheet">${photos}</div>
        <script>
          // Give images time to load from Blob URL before triggering print
          window.onload = () => {
            setTimeout(() => {
              window.print();
              // Prevent memory leaks by revoking the Blob URL after printing
              setTimeout(() => {
                window.URL.revokeObjectURL('${photoUrl}');
              }, 1000);
            }, 500);
          };
        </script>
      </body>
      </html>
    `);
    printWindow.document.close();
  }, 'image/png', 1.0);
});

setCanvasBackground();
