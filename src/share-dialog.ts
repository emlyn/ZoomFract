type QrCodeFactory = typeof import('qrcode-generator');

// The Share dialog: the picture as an image file, a link to the definition,
// and a QR code for the link.

export type LinkOptions = { inputs: boolean; settings: boolean };

type ShareDialogOptions = {
  canvas: HTMLCanvasElement;
  background: () => string;
  fileName: () => string;
  hasInputs: () => boolean;
  hasUnappliedEdits: () => boolean;
  link: (options: LinkOptions) => Promise<string>;
  definition: () => string;
  loadDefinition: (text: string) => boolean;
};

const IMAGE_SCALES = [1, 1 / 2, 1 / 4];
const PREVIEW_MAX_WIDTH = 480;
const PREVIEW_MAX_HEIGHT = 300;
// Enlarged, the preview is bounded by the wider dialog instead.
const PREVIEW_ZOOM_MAX_WIDTH = 640;
const PREVIEW_ZOOM_MAX_HEIGHT = 600;
const QR_MARGIN_MODULES = 4;
const QR_TARGET_PIXELS = 1024;
// The preview shows the code at one of these fractions of its full size.
// Squares are a whole number of pixels at both, so neither blurs the edges.
const QR_PREVIEW_SCALES = [1 / 4, 1 / 2];
const QR_SCALE_STEPS = 4;
// The picture covers at most this fraction of the code's width. With the
// highest error correction a code can lose about 30% of its data, and the
// picture hides under 10% of it, leaving room for smudges and glare.
const QR_PICTURE_FRACTION = 0.3;
// The white halo around the preview, in QR squares: solid, then fading out.
const QR_HALO_SOLID = 0.5;
const QR_HALO_RADIUS = 1;
// As fractions of the preview's larger side: gaps narrower than about twice
// the closing distance are filled in white, and thin lines are thickened by
// the thicken distance.
const QR_PICTURE_CLOSING = 0.08;
const QR_PICTURE_THICKEN = 0.003;

type Bounds = { x: number; y: number; width: number; height: number };

function readableContext(image: HTMLCanvasElement) {
  const copy = document.createElement('canvas');
  copy.width = image.width;
  copy.height = image.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not create a canvas for the image');
  }
  context.drawImage(image, 0, 0);
  return context;
}

// The smallest rectangle holding every pixel that is not fully transparent.
function opaqueBounds(image: HTMLCanvasElement): Bounds | null {
  const { data, width, height } = readableContext(image).getImageData(0, 0, image.width, image.height);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// Distance from each pixel to the nearest set pixel of a mask, using the
// exact Euclidean distance transform of Felzenszwalb and Huttenlocher.
function distanceField(mask: Uint8Array, width: number, height: number) {
  const far = 1e20;
  const grid = Float64Array.from(mask, (set) => (set ? 0 : far));
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const pass = (n: number, index: (i: number) => number) => {
    for (let i = 0; i < n; i += 1) {
      f[i] = grid[index(i)];
    }
    const meet = (q: number, p: number) => (f[q] + q * q - f[p] - p * p) / (2 * (q - p));
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q += 1) {
      let s = meet(q, v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = meet(q, v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q += 1) {
      while (z[k + 1] < q) {
        k += 1;
      }
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
    for (let i = 0; i < n; i += 1) {
      grid[index(i)] = d[i];
    }
  };
  for (let x = 0; x < width; x += 1) {
    pass(height, (y) => y * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pass(width, (x) => y * width + x);
  }
  return grid.map(Math.sqrt);
}

// A white backing for the image: its shape with gaps narrower than about
// twice `closing` filled in (grown by `closing`, then shrunk back), solid up
// to `solid` pixels outside that and fading out by `radius`. The result is
// padded by `reach` on each side.
function backing(image: HTMLCanvasElement, closing: number, solid: number, radius: number) {
  const { data } = readableContext(image).getImageData(0, 0, image.width, image.height);
  const reach = Math.ceil(closing + radius) + 1;
  const width = image.width + 2 * reach;
  const height = image.height + 2 * reach;
  const shape = new Uint8Array(width * height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      shape[(y + reach) * width + x + reach] = data[(y * image.width + x) * 4 + 3] > 0 ? 1 : 0;
    }
  }
  const outsideGrown = distanceField(shape, width, height).map((distance) => (distance > closing ? 1 : 0));
  const closed = distanceField(Uint8Array.from(outsideGrown), width, height)
    .map((distance) => (distance > closing ? 1 : 0));
  const fromClosed = distanceField(Uint8Array.from(closed), width, height);
  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const context = context2d(target);
  const pixels = context.createImageData(width, height);
  fromClosed.forEach((distance, index) => {
    const alpha = Math.min(1, Math.max(0, (radius - distance) / (radius - solid)));
    pixels.data.set([255, 255, 255, Math.round(alpha * 255)], index * 4);
  });
  context.putImageData(pixels, 0, 0);
  return { image: target, reach };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(className: string, text: string) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function checkboxRow(label: string, checked: boolean) {
  const row = element('label', 'edit-mode-row');
  row.append(element('span', '', label));
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  row.append(input);
  return { row, input };
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? `${fallback}: ${error.message}` : fallback;

function context2d(target: HTMLCanvasElement) {
  const context = target.getContext('2d');
  if (!context) {
    throw new Error('Could not create a canvas for the image');
  }
  return context;
}

const pngBlob = (image: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => image.toBlob((blob) => {
  if (blob) {
    resolve(blob);
  } else {
    reject(new Error('Could not create PNG'));
  }
}, 'image/png'));

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// The smallest code that holds the text, using the highest error correction
// when part of it will be hidden by the picture.
function makeQrCode(text: string, withPicture: boolean, qrcode: QrCodeFactory) {
  const code = qrcode(0, withPicture ? 'H' : 'M');
  code.addData(text, 'Byte');
  try {
    code.make();
  } catch {
    throw new Error(withPicture ? 'The link is too long for a QR code with a preview' : 'The link is too long for a QR code');
  }
  return code;
}

export function createShareDialog(options: ShareDialogOptions) {
  const { canvas } = options;
  const dialog = element('dialog', 'share-dialog');
  dialog.setAttribute('aria-label', 'Share');
  // Focusing the dialog itself avoids a focus ring on the first tab.
  dialog.tabIndex = -1;
  let imageReady = false;

  const header = element('div', 'share-header');
  const tabList = element('div', 'share-tabs');
  tabList.setAttribute('role', 'tablist');
  const close = button('guide-close', '\u00d7');
  close.setAttribute('aria-label', 'Close');
  header.append(tabList, close);

  const status = element('p', 'scene-status share-status');
  status.setAttribute('role', 'status');
  const showStatus = (text: string, isError = false) => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };

  // Image tab.
  const preview = element('canvas', 'share-preview');
  const sizeRow = element('label', 'select-row');
  sizeRow.append(element('span', '', 'Size'));
  const sizeSelect = document.createElement('select');
  sizeRow.append(sizeSelect);
  const transparent = checkboxRow('Transparent background', false);
  const copyImage = button('apply-scene', 'Copy');
  const downloadImage = button('apply-scene', 'Download');
  const imageButtons = element('div', 'share-buttons');
  imageButtons.append(copyImage, downloadImage);
  const imagePanel = element('div', 'share-panel');
  imagePanel.append(preview, sizeRow, transparent.row, imageButtons);

  // The link options are shared by the Link and QR code tabs, and move to
  // whichever of them is shown.
  const includeInputs = checkboxRow('Include input values', true);
  const includeSettings = checkboxRow('Include app settings', false);
  includeSettings.row.title = 'Quality, render settings and whether the label is shown';
  const linkOptions = element('div', 'share-options');
  linkOptions.append(includeInputs.row, includeSettings.row);

  // Link tab.
  const linkText = element('textarea', 'share-link-text');
  linkText.readOnly = true;
  linkText.rows = 4;
  linkText.spellcheck = false;
  const copyLink = button('apply-scene', 'Copy');
  const linkPanel = element('div', 'share-panel');
  linkPanel.append(linkText, copyLink);

  // QR code tab.
  const qrPreview = element('canvas', 'share-preview share-qr');
  const qrPicture = checkboxRow('Include preview', true);
  const copyQr = button('apply-scene', 'Copy');
  const downloadQr = button('apply-scene', 'Download');
  const qrButtons = element('div', 'share-buttons');
  qrButtons.append(copyQr, downloadQr);
  const qrPanel = element('div', 'share-panel');
  qrPanel.append(qrPreview, qrPicture.row, qrButtons);

  // Definition tab.
  const definitionText = element('textarea', 'share-link-text share-definition-text');
  definitionText.readOnly = true;
  definitionText.rows = 8;
  definitionText.spellcheck = false;
  const downloadDefinition = button('apply-scene', 'Download');
  const openDefinition = button('apply-scene', 'Open file...');
  const definitionFile = document.createElement('input');
  definitionFile.type = 'file';
  definitionFile.accept = '.yaml,.yml,.txt,text/yaml,text/plain';
  definitionFile.hidden = true;
  const definitionButtons = element('div', 'share-buttons');
  definitionButtons.append(downloadDefinition, openDefinition);
  const definitionPanel = element('div', 'share-panel');
  definitionPanel.append(definitionText, definitionButtons, definitionFile);

  const tabs = [
    { name: 'Image', panel: imagePanel },
    { name: 'Link', panel: linkPanel },
    { name: 'QR code', panel: qrPanel },
    { name: 'Definition', panel: definitionPanel },
  ].map(({ name, panel }) => {
    const tab = button('share-tab', name);
    tab.setAttribute('role', 'tab');
    panel.setAttribute('role', 'tabpanel');
    tabList.append(tab);
    return { tab, panel };
  });

  dialog.append(header, ...tabs.map(({ panel }) => panel), status);

  const scale = () => IMAGE_SCALES[sizeSelect.selectedIndex];
  const imageSize = (factor: number) => ({
    width: Math.max(1, Math.round(canvas.width * factor)),
    height: Math.max(1, Math.round(canvas.height * factor)),
  });

  // The picture at the chosen size, on the background unless it is transparent.
  function drawImage(target: HTMLCanvasElement, width: number, height: number, withBackground: boolean) {
    target.width = width;
    target.height = height;
    const context = context2d(target);
    if (withBackground) {
      context.fillStyle = options.background();
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, width, height);
    return target;
  }

  function imageBlob(): Promise<Blob> {
    const { width, height } = imageSize(scale());
    return pngBlob(drawImage(document.createElement('canvas'), width, height, !transparent.input.checked));
  }

  let imageZoom = 0;

  function refreshImage() {
    const selected = Math.max(0, sizeSelect.selectedIndex);
    sizeSelect.replaceChildren(...IMAGE_SCALES.map((factor) => {
      const { width, height } = imageSize(factor);
      return new Option(`${width} \u00d7 ${height} px`);
    }));
    sizeSelect.selectedIndex = selected;
    const { width, height } = imageSize(1);
    const zoomed = imageZoom > 0;
    const maxWidth = zoomed ? PREVIEW_ZOOM_MAX_WIDTH : PREVIEW_MAX_WIDTH;
    const maxHeight = zoomed ? PREVIEW_ZOOM_MAX_HEIGHT : PREVIEW_MAX_HEIGHT;
    // Never larger than the picture itself, so zooming cannot blur it.
    const fit = Math.min(1, maxWidth / width, maxHeight / height);
    drawImage(preview, Math.round(width * fit), Math.round(height * fit), !transparent.input.checked);
    preview.classList.toggle('transparent', transparent.input.checked);
    preview.classList.toggle('zoomed', zoomed);
    dialog.classList.toggle('wide', zoomed);
    preview.title = zoomed ? 'Click to shrink' : 'Click to enlarge';
    copyImage.disabled = !imageReady;
    downloadImage.disabled = !imageReady;
    showStatus(imageReady ? '' : 'Available when rendering finishes');
  }

  preview.addEventListener('click', () => {
    imageZoom = imageZoom === 0 ? 1 : 0;
    refreshImage();
  });

  // Black modules on white with a quiet zone, and the drawn part of the
  // picture over the middle on a white backing that follows its shape.
  async function drawQrCode(target: HTMLCanvasElement, text: string, withPicture: boolean) {
    const { default: qrcode } = await import('qrcode-generator');
    const code = makeQrCode(text, withPicture, qrcode);
    const count = code.getModuleCount();
    // A multiple of the smallest preview step, so every square stays a whole
    // number of pixels when the preview shrinks it.
    const wanted = QR_TARGET_PIXELS / (count + 2 * QR_MARGIN_MODULES);
    const cell = QR_SCALE_STEPS * Math.max(1, Math.ceil(wanted / QR_SCALE_STEPS));
    const size = cell * (count + 2 * QR_MARGIN_MODULES);
    target.width = size;
    target.height = size;
    const context = context2d(target);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#000';
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (code.isDark(row, column)) {
          context.fillRect((column + QR_MARGIN_MODULES) * cell, (row + QR_MARGIN_MODULES) * cell, cell, cell);
        }
      }
    }
    const bounds = withPicture ? opaqueBounds(canvas) : null;
    if (bounds) {
      const box = Math.floor(count * QR_PICTURE_FRACTION) * cell;
      const fit = Math.min((box - 2 * cell) / bounds.width, (box - 2 * cell) / bounds.height);
      const width = Math.max(1, Math.round(bounds.width * fit));
      const height = Math.max(1, Math.round(bounds.height * fit));
      const picture = document.createElement('canvas');
      picture.width = width;
      picture.height = height;
      const pictureContext = context2d(picture);
      pictureContext.imageSmoothingQuality = 'high';
      pictureContext.drawImage(canvas, -bounds.x * fit, -bounds.y * fit, canvas.width * fit, canvas.height * fit);
      const x = Math.round((size - width) / 2);
      const y = Math.round((size - height) / 2);
      const glow = backing(
        picture,
        Math.max(width, height) * QR_PICTURE_CLOSING,
        cell * QR_HALO_SOLID,
        cell * QR_HALO_RADIUS,
      );
      context.drawImage(glow.image, x - glow.reach, y - glow.reach);
      // Copies nudged around a small circle thicken lines too thin to see.
      const thicken = Math.max(width, height) * QR_PICTURE_THICKEN;
      for (let step = 0; step < 8; step += 1) {
        const angle = (step * Math.PI) / 4;
        context.drawImage(picture, x + thicken * Math.cos(angle), y + thicken * Math.sin(angle));
      }
      context.drawImage(picture, x, y);
    }
    return { image: target, count };
  }

  let linkRevision = 0;
  let qrImage: HTMLCanvasElement | null = null;
  let qrZoom = 0;

  // Drawn at an exact fraction of the full code so squares keep sharp edges.
  function showQrCode() {
    if (!qrImage) {
      return;
    }
    const size = Math.round(qrImage.width * QR_PREVIEW_SCALES[qrZoom]);
    qrPreview.width = size;
    qrPreview.height = size;
    qrPreview.style.width = `${size}px`;
    const context = context2d(qrPreview);
    context.imageSmoothingQuality = 'high';
    context.drawImage(qrImage, 0, 0, size, size);
    const zoomed = qrZoom > 0;
    qrPreview.classList.toggle('zoomed', zoomed);
    dialog.classList.toggle('wide', zoomed);
    qrPreview.title = zoomed ? 'Click to shrink' : 'Click to enlarge';
  }

  function clearQrPreview() {
    qrImage = null;
    qrZoom = 0;
    dialog.classList.remove('wide');
    qrPreview.classList.remove('zoomed');
    qrPreview.removeAttribute('title');
    context2d(qrPreview).clearRect(0, 0, qrPreview.width, qrPreview.height);
  }

  qrPreview.addEventListener('click', () => {
    if (!qrImage) {
      return;
    }
    qrZoom = (qrZoom + 1) % QR_PREVIEW_SCALES.length;
    showQrCode();
  });

  // Makes the link, then shows it in whichever of the Link and QR code tabs is open.
  async function refreshLink() {
    const revision = ++linkRevision;
    const panel = currentTab();
    includeInputs.row.hidden = !options.hasInputs();
    copyLink.disabled = true;
    copyQr.disabled = true;
    downloadQr.disabled = true;
    try {
      const url = await options.link({ inputs: includeInputs.input.checked, settings: includeSettings.input.checked });
      if (revision !== linkRevision) {
        return;
      }
      const unapplied = options.hasUnappliedEdits() ? ', without unapplied edits' : '';
      if (panel === linkPanel) {
        linkText.value = url;
        copyLink.disabled = false;
        showStatus(`${url.length} characters${unapplied}`);
        return;
      }
      if (qrPicture.input.checked && !imageReady) {
        clearQrPreview();
        showStatus('Available when rendering finishes');
        return;
      }
      const { image, count } = await drawQrCode(document.createElement('canvas'), url, qrPicture.input.checked);
      if (revision !== linkRevision) {
        return;
      }
      qrImage = image;
      showQrCode();
      copyQr.disabled = false;
      downloadQr.disabled = false;
      showStatus(`${count} \u00d7 ${count} squares${unapplied}`);
    } catch (error) {
      if (revision === linkRevision) {
        clearQrPreview();
        showStatus(errorMessage(error, panel === qrPanel ? 'Could not make QR code' : 'Could not make link'), true);
      }
    }
  }

  const currentTab = () => tabs.find(({ panel }) => !panel.hidden)?.panel;

  function showTab(index: number) {
    tabs.forEach(({ tab, panel }, tabIndex) => {
      tab.setAttribute('aria-selected', String(tabIndex === index));
      panel.hidden = tabIndex !== index;
    });
  }

  function selectTab(index: number) {
    showTab(index);
    showStatus('');
    const { panel } = tabs[index];
    if (panel === linkPanel || panel === definitionPanel) {
      dialog.classList.remove('wide');
    }
    if (panel === imagePanel) {
      refreshImage();
    } else if (panel === definitionPanel) {
      refreshDefinition();
    } else {
      panel.insertBefore(linkOptions, panel === linkPanel ? copyLink : qrPicture.row);
      void refreshLink();
    }
  }

  tabs.forEach(({ tab }, index) => tab.addEventListener('click', () => selectTab(index)));
  close.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  sizeSelect.addEventListener('change', refreshImage);
  transparent.input.addEventListener('change', refreshImage);
  for (const input of [includeInputs.input, includeSettings.input, qrPicture.input]) {
    input.addEventListener('change', () => void refreshLink());
  }

  async function copyPng(blob: Promise<Blob>, done: string) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showStatus(done);
    } catch (error) {
      showStatus(errorMessage(error, 'Could not copy image'), true);
    }
  }

  async function savePng(blob: () => Promise<Blob>, fileName: string) {
    try {
      downloadBlob(await blob(), fileName);
    } catch (error) {
      showStatus(errorMessage(error, 'Could not save image'), true);
    }
  }

  const qrBlob = () => qrImage ? pngBlob(qrImage) : Promise.reject(new Error('The QR code is not ready'));

  // The applied definition, which the link and the file both hold.
  function refreshDefinition() {
    const text = options.definition().trim();
    definitionText.value = text;
    const lines = text.split('\n').length;
    const unapplied = options.hasUnappliedEdits() ? ', without unapplied edits' : '';
    showStatus(`${lines} ${lines === 1 ? 'line' : 'lines'}${unapplied}`);
  }

  async function openDefinitionFile(file: File) {
    try {
      if (!options.loadDefinition(await file.text())) {
        showStatus(`${file.name} is not a valid definition`, true);
        return;
      }
      dialog.close();
    } catch (error) {
      showStatus(errorMessage(error, 'Could not read the file'), true);
    }
  }

  downloadDefinition.addEventListener('click', () => downloadBlob(
    new Blob([`${options.definition().trim()}\n`], { type: 'text/yaml' }),
    `zoomfract-${options.fileName()}.yaml`,
  ));
  openDefinition.addEventListener('click', () => definitionFile.click());
  definitionFile.addEventListener('change', () => {
    const file = definitionFile.files?.[0];
    definitionFile.value = '';
    if (file) {
      void openDefinitionFile(file);
    }
  });

  const copyText = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showStatus(done);
    } catch (error) {
      showStatus(errorMessage(error, 'Could not copy'), true);
    }
  };

  copyImage.addEventListener('click', () => void copyPng(imageBlob(), 'Image copied'));
  downloadImage.addEventListener('click', () => void savePng(imageBlob, `zoomfract-${options.fileName()}.png`));
  copyQr.addEventListener('click', () => void copyPng(qrBlob(), 'QR code copied'));
  downloadQr.addEventListener('click', () => void savePng(qrBlob, `zoomfract-${options.fileName()}-qr.png`));
  copyLink.addEventListener('click', () => void copyText(linkText.value, 'Link copied'));

  // Ctrl+C copies whatever the open tab shows, unless some text is selected.
  const textSelected = () => {
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) {
      return focused.selectionStart !== focused.selectionEnd;
    }
    return !(window.getSelection()?.isCollapsed ?? true);
  };

  dialog.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey) || event.altKey || textSelected()) {
      return;
    }
    const panel = currentTab();
    if (panel === imagePanel && imageReady) {
      void copyPng(imageBlob(), 'Image copied');
    } else if (panel === qrPanel && qrImage) {
      void copyPng(qrBlob(), 'QR code copied');
    } else if (panel === linkPanel && linkText.value) {
      void copyText(linkText.value, 'Link copied');
    } else if (panel === definitionPanel) {
      void copyText(definitionText.value, 'Definition copied');
    } else {
      return;
    }
    event.preventDefault();
  });

  showTab(0);

  return {
    element: dialog,
    open() {
      dialog.showModal();
      dialog.focus();
      selectTab(tabs.findIndex(({ panel }) => panel === currentTab()));
    },
    close() {
      dialog.close();
    },
    setImageReady(ready: boolean) {      imageReady = ready;
      if (!dialog.open) {
        return;
      }
      if (currentTab() === imagePanel) {
        refreshImage();
      } else if (currentTab() === qrPanel && qrPicture.input.checked) {
        void refreshLink();
      }
    },
  };
}
