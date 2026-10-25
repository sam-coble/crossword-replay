const EXTENSION_NAME = '[crossword-replay]';
console.log(EXTENSION_NAME, 'Extension loaded!');

// Configs
const MAX_HISTORY_SIZE = 1000;

const SLIDER_DEFAULT_FPS = 10;
const SLIDER_MIN_FPS = 1;
const SLIDER_MAX_FPS = 30;

const VIDEO_KBPS = 5000; // Kibibit per second
const HOLD_LAST_FRAME_MS = 1000; // how long to hold the final grid at end of WebM

const PERSIST_INTERVAL_MS = 1000; // how often to flush new mutations to storage
const PUZZLE_RECORD_PREFIX = 'nyt:daily:';
const STORAGE_BUDGET_BYTES = 5 * 1024 * 1024; // purge oldest records above this (chrome.storage.local limit is 10 MB)

const MENU_ANIMATION_MS = 200;

// State
let mutationTracker = []; // one entry per replay frame: [[{ row, col, value }, ...], ...]
let originalGridSvgString = null;

let isMenuOpen = false;

let recordMutationsToDisk = false;
let hasUnsavedMutations = false;
let recordKey = null;
let compressedSvg = null; // cached so the svg isn't recompressed on every write
let needToResetStoredSvg = true; // compressedSvg is missing or out of date

/**
 * Helper to read cell current letter(s) from SVG element.
 */
function getCellValue(cell) {
	const letterText = cell.querySelector('text[text-anchor="middle"]');
	const letterNode = Array.from(letterText?.childNodes ?? []).find(node => node.nodeType === Node.TEXT_NODE);
	return letterNode?.textContent ?? '';
}

/**
 * Helper to capture a cleaned, styled snapshot of grid SVG.
 */
function captureGridSnapshot(gridSvgElement) {
	const rawSvg = gridSvgElement.cloneNode(true /* deepClone */).outerHTML;
	const styledSvg = getStyledSvg(rawSvg, document.styleSheets, '.xwd__');
	return cleanSvgForReplay(styledSvg);
}

/**
 * Restarts recording from the blank grid after a full grid clear.
 */
function resetRecording() {
	const METHOD_NAME = 'resetRecording';
	originalGridSvgString = captureGridSnapshot(document.getElementById('xwd-board'));
	needToResetStoredSvg = true;
	mutationTracker = [];
	hasUnsavedMutations = true;
	console.debug(EXTENSION_NAME, METHOD_NAME, '[INFO] Grid cleared, recording restarted');
}

/**
 * Observer function to trigger on all updates of xwd grid, find the
 * updated cell(s), and append the mutation to history tracker.
 * Should only be triggered on *characterData* update (i.e. not
 * attribute/highlighting change) 
 */
const onGridUpdate = (mutationsList, observer) => {
	const changedCells = new Set(mutationsList
		.map(mut => mut.target.parentElement?.closest('g[aria-rowindex][aria-colindex]'))
		.filter(Boolean));
	if (changedCells.size === 0) return;

	const frame = Array.from(changedCells).map(cell => ({
		row: +cell.ariaRowIndex,
		col: +cell.ariaColIndex,
		value: getCellValue(cell),
	}));

	// Detect if grid has been cleared (all cells empty). If so, reset recording
	// If there is word clear (or any other case where multiple cells edited simultaneously 
	// but grid is not fully empty), track all mutations as happening in single frame.
	if (frame.every(({ value }) => value === '')
		&& [...document.querySelectorAll('#xwd-board g[aria-rowindex][aria-colindex]')].every(cell => getCellValue(cell) === '')) {
		resetRecording();
		return;
	}

	mutationTracker.push(frame);
	hasUnsavedMutations = true;

	if (mutationTracker.length >= MAX_HISTORY_SIZE) {
		console.warn(EXTENSION_NAME, `[WARN] Exceeded max move count (${MAX_HISTORY_SIZE}). Stopping replay capture.`);
		observer.disconnect();
	}
};

const gridObserver = new MutationObserver(onGridUpdate);
const gridObserverConfig = {
	attributes: false,
	childList: true,
	characterData: true,
	subtree: true,
};

/**
 * Helper to extract css from page and apply inline to SVG string
 */
function getStyledSvg(svgString, styleSheets, cssSelectorPrefix) {
	const extractedStyles = Array.from(styleSheets)
		.flatMap(sheet => {
			try {
				return Array.from(sheet.cssRules);
			} catch { // `cssRules` access can throw DOMException on cross-origin stylesheets
				return [];
			}
		})
		.filter(rule => rule.selectorText?.includes(cssSelectorPrefix))
		.map(rule => rule.cssText ?? '')
		.join('\n');

	// Escape unsafe characters in CSS to prevent breaking SVG.
	const safeStyles = extractedStyles
		.replace(/&/g, '&amp;') // should be first
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	const styleBlock = `<style type="text/css">${safeStyles}</style>`;

	return svgString.replace(/(<svg[^>]*>)/i, `$1${styleBlock}`);
}

/**
 * Helper to clean SVG by removing highlighting, aria attributes, and
 * other elements which break SVG rendering or are unneeded.
 */
function cleanSvgForReplay(svgString) {
	let ret = svgString
		// Highlighting
		.replace(/xwd__cell--selected/g, '')
		.replace(/xwd__cell--highlighted/g, '')
		// Broken links
		.replace(/<use[^>]*xlink:href[^>]*><\/use>/g, '')
		.replace(/<use[^>]*xlink:href[^>]*\/>/g, '')
		// Useless - remove for compression
		.replace(/aria-selected="true"/g, 'aria-selected="false"')
		.replace(/\s*aria-label="[^"]*"/g, '')
		.replace(/<text class="xwd__cell--hidden">[^<]*<\/text>/g, '')
		.replace(/\s*id="cell-id-\d+"/g, '')
		.replace(/\s*data-testid="[^"]*"/g, '');

	// Add xmlns attributes required in SVG
	if (!ret.includes('xmlns="http://www.w3.org/2000/svg"')) {
		ret = ret.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
	}
	if (ret.includes('xlink:') && !ret.includes('xmlns:xlink')) {
		ret = ret.replace('<svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
	}

	// Set explicit SVG height/width to match viewbox
	const viewbox = ret.match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
	if (viewbox && !ret.match(/<svg[^>]*\bwidth="/)) {
		ret = ret.replace('<svg', `<svg width="${viewbox[3]}" height="${viewbox[4]}"`);
	}

	// Center grid within canvas
	ret = ret.replace(/preserveAspectRatio="[^"]*"/, 'preserveAspectRatio="xMidYMid meet"');

	return ret;
}

/**
 * Helper to compute cell font-size, needed for rebus cells.
 * | # letters |   1   |   2   |   3   |   4   |   5   |
 * | font-size | 23.33 | 23.33 | 15.55 | 11.66 | 9.332 |
 * 
 * font-size ~= (cellWidth * 2/3) / max(2, N)
 */
function getCellFontSize(cellInner, value) {
	const cellWidth = parseFloat(cellInner.match(/<rect[^>]*\bwidth="([\d.]+)"/)?.[1] ?? 33);
	const baseFontSize = Math.round(cellWidth * 2 / 3 * 100) / 100;
	return baseFontSize * Math.min(1, 2 / value.length);
}

/**
 * Helper to apply a single cell mutation to an SVG string. Locates the cell's
 * letter content by aria-rowindex/aria-colindex and replaces old value with new.
 */
function getNextSvg(prevSvgString, mutation) {
	const METHOD_NAME = "getNextSvg";
	const { row, col, value } = mutation;

	const cellOpenPattern1 = new RegExp(`<g\\s[^>]*?aria-rowindex="${row}"[^>]*?aria-colindex="${col}"[^>]*?>`);
	const cellOpenPattern2 = new RegExp(`<g\\s[^>]*?aria-colindex="${col}"[^>]*?aria-rowindex="${row}"[^>]*?>`);
	const cellOpenMatch = prevSvgString.match(cellOpenPattern1) || prevSvgString.match(cellOpenPattern2);
	if (!cellOpenMatch) {
		console.debug(EXTENSION_NAME, METHOD_NAME, `[WARN] cell not found at row=${row}, col=${col}`);
		return prevSvgString;
	}

	const gOpenStart = cellOpenMatch.index;
	const gOpenEnd = gOpenStart + cellOpenMatch[0].length;
	const gCloseStart = prevSvgString.indexOf('</g>', gOpenEnd);
	if (gCloseStart === -1) {
		console.debug(EXTENSION_NAME, METHOD_NAME, `[WARN] couldn't find closing </g> for cell row=${row}, col=${col}`);
		return prevSvgString;
	}

	// Perform replacement with new cell value
	const cellInner = prevSvgString.substring(gOpenEnd, gCloseStart);
	const fontSize = getCellFontSize(cellInner, value);
	// Letter element: <text text-anchor="middle" ...>OLD</text>
	const letterTextPattern = /(<text[^>]*text-anchor="middle"[^>]*>)[^<]*<\/text>/;
	const updatedCellInner = cellInner.replace(letterTextPattern, (_match, textOpen) => {
		const newTextOpen = textOpen.replace(/font-size="[^"]*"/, `font-size="${fontSize}"`);
		return `${newTextOpen}${value}</text>`;
	});
	if (updatedCellInner === cellInner) {
		console.debug(EXTENSION_NAME, METHOD_NAME, `[WARN] text element not found in cell row=${row}, col=${col}`);
	}

	return prevSvgString.substring(0, gOpenEnd) + updatedCellInner + prevSvgString.substring(gCloseStart);
}

/**
 * Generator to yield next SVG frame image by applying recorded grid mutations
 * one at a time.
 */
function* generateSvgFrames() {
	const METHOD_NAME = 'generateSvgFrames';
	if (!originalGridSvgString) {
		console.debug(EXTENSION_NAME, METHOD_NAME, '[ERROR] No initial grid snapshot captured');
		return;
	}
	let currentSvg = originalGridSvgString;
	yield currentSvg;
	for (const frame of mutationTracker) {
		for (const mutation of frame) {
			currentSvg = getNextSvg(currentSvg, mutation);
		}
		yield currentSvg;
	}
}

/**
 * Helper to get total frame count of replay animation.
 */
function getFrameCount() {
	return originalGridSvgString ? mutationTracker.length + 1 : 0;
}

/**
 * Helper to get canvas dimensions of grid SVG in pixels
 */
function getGridDimensions() {
	const vbMatch = originalGridSvgString?.match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
	if (vbMatch) {
		return {
			width: Math.ceil(parseFloat(vbMatch[3])),
			height: Math.ceil(parseFloat(vbMatch[4])),
		};
	} else {
		return {
			width: 501,
			height: 501,
		};
	}
}

/**
 * Async helper to encode SVG string into an Image obj via a Blob URL.
 */
async function loadSvgAsImage(svgString) {
	const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const img = new Image();
	img.src = url;
	try {
		await img.decode();
		return img;
	} catch (e) {
		console.error(EXTENSION_NAME, 'SVG image load failed. First 500 chars:', svgString.substring(0, 500));
		throw e;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function getSupportedMimeType() {
	const METHOD_NAME = 'getSupportedMimeType';
	for (const mimeType of ['video/webm; codecs=vp9', 'video/webm; codecs=vp8', 'video/webm']) {
		if (MediaRecorder.isTypeSupported(mimeType)) {
			console.debug(EXTENSION_NAME, METHOD_NAME, '[INFO] Using video codec', mimeType)
			return mimeType;
		}
	}
	console.debug(EXTENSION_NAME, METHOD_NAME, '[ERROR] No supported video codecs');
}

/**
 * Helper to size canvas to the grid's native SVG dimensions.
 */
function sizeCanvasToGrid(canvas) {
	const {width, height} = getGridDimensions();
	canvas.width = width;
	canvas.height = height;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Draws one full playthrough of grid mutations onto canvas, one frame every
 * getFrameDelay() ms, awaiting onFrameDrawn() after each frame is drawn. Returns
 * true if playthrough completed, or false if isStopped() became true first.
 */
async function playFramesOnce(canvas, getFrameDelay, isStopped, onFrameDrawn = async () => {}) {
	const ctx = canvas.getContext('2d');
	let frameNumber = 0;
	for (const svgString of generateSvgFrames()) {
		const frameStart = performance.now();
		try {
			const img = await loadSvgAsImage(svgString);
			if (isStopped()) return false; // stopped during decode, don't draw
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			await onFrameDrawn();
		} catch (e) {
			console.debug(EXTENSION_NAME, 'playFramesOnce', `[WARN] skipped frame ${frameNumber}:`, e);
		}
		await sleep(Math.max(0, getFrameDelay() - (performance.now() - frameStart)));
		if (isStopped()) return false;
		frameNumber++;
	}
	return true;
}

/**
 * Encodes one full cycle of grid mutations to a WebM blob by replaying
 * frames one at a time onto canvas and recording playback. 
 * @param canvas Canvas element to draw frames to and record
 * @param frameDelay Time delay in ms between drawing each frame
 * @param isStopped Callback to call periodically to determine if to abort encoding (e.g. menu closed)
 * @param onFinish Callback to call if encoding completes successfully (not stopped or failed)
 */
async function recordCanvasToWebm(canvas, frameDelay, isStopped, onFinish) {
	const METHOD_NAME = 'recordCanvasToWebm';
	console.debug(EXTENSION_NAME, METHOD_NAME, `recording ${getFrameCount()} frames from live canvas...`);
	sizeCanvasToGrid(canvas);

	try {
		const stream = canvas.captureStream(0);
		const track = stream.getVideoTracks()[0];
		const recorder = new MediaRecorder(stream, {
			mimeType: getSupportedMimeType(),
			videoBitsPerSecond: VIDEO_KBPS * 1000,
		});
		const chunks = [];
		recorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) chunks.push(e.data);
		};
		const captureFrame = async () => {
			await new Promise(resolve => requestAnimationFrame(resolve)); // let canvas composite before capture
			track.requestFrame();
		};

		// Replay frames on canvas
		recorder.start(1000);
		try {
			await playFramesOnce(canvas, () => frameDelay, isStopped, captureFrame);
			// Hold last frame
			const holdEnd = performance.now() + HOLD_LAST_FRAME_MS;
			while (!isStopped() && performance.now() < holdEnd) {
				await captureFrame();
				await sleep(frameDelay);
			}
		} finally {
			recorder.stop();
		}
		// Capture recording data
		const blob = await new Promise(resolve => recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })));

		if (isStopped()) {
			console.debug(EXTENSION_NAME, METHOD_NAME, '[INFO] Recording stopped early, discarding');
			return;
		}
		console.debug(EXTENSION_NAME, METHOD_NAME, `[INFO] WebM recorded: ${(blob.size / 1024).toFixed(1)} KB`);
		onFinish(blob);
	} catch (e) {
		console.error(EXTENSION_NAME, '[ERROR] WebM encoding failed:', e);
		if (!isStopped()) onFinish(null);
	}
}

/**
 * Helper to trigger a browser download of a blob with the given filename.
 */
function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/**
 * Helper function to get puzzle date (YYYY-MM-DD) from the page title, e.g.
 *   "Tuesday, October 20, 2026 The Crossword puzzle — The New York Times" => "2026-10-20"
 */
function getPuzzleDate() {
	const date = new Date(document.title.split('The')[0]);
	return (date ?? Date.now()).toISOString().split('T')[0];
}

/**
 * Starts a looping replay on given canvas by applying and animating grid
 * mutations one at a time. Loops indefinetly until stopped.
 */
async function createCanvasPlayer(canvas, getFrameDelay, isStopped) {
	const METHOD_NAME = 'createCanvasPlayer';
	if (!originalGridSvgString) {
		console.debug(EXTENSION_NAME, METHOD_NAME, '[ERROR] no frames found');
		return;
	}
	sizeCanvasToGrid(canvas);
	// Cycle replay until menu is closed
	while (await playFramesOnce(canvas, getFrameDelay, isStopped) && !isStopped()) {
		// Pause on final frame
		await sleep(HOLD_LAST_FRAME_MS);
	}
}

/**
 * Click handler for the replay menu button. Opens the replay modal, renders the
 * timelapse on a canvas in real-time, and prepares the WebM download in the
 * background. No-op if the modal is already open.
 */
function showReplayMenu() {
	const METHOD_NAME = 'showReplayMenu';
	if (isMenuOpen) return;
	isMenuOpen = true;

	// Set button inactive
	const button = document.getElementById('xwd-replay-button');
	if (button) {
		button.disabled = true;
	}

	try {
		const totalFrames = getFrameCount();
		if (totalFrames === 0) {
			console.debug(EXTENSION_NAME, METHOD_NAME, '[ERROR] No grid snapshot captured');
			isMenuOpen = false;
			return;
		}
		console.debug(EXTENSION_NAME, METHOD_NAME, `[INFO] ${totalFrames} frames to replay`);

		// Create menu overlay
		const menuDiv = document.createElement('div');
		menuDiv.id = 'xwd-replay-modal';
		menuDiv.innerHTML = `
			<div role="dialog" aria-modal="true" class="modal-system-container" data-testid="modal-wrapper" aria-label="Solve Replay">
				<div class="xwd__modal--wrapper">
					<div class="xwd__modal--overlay" id="xwd-replay-overlay"></div>
					<div class="xwd__modal--body xwd__print-modal--body animate-opening" tabindex="0" data-testid="modal-body" style="--modal-animation-duration: ${MENU_ANIMATION_MS}ms;">
						<button type="button" aria-label="close" class="xwd__modal--close" id="xwd-replay-close">
							<i class="pz-icon pz-icon-close"></i>
						</button>
						<article class="xwd__modal--content" style="justify-content: safe center;">
							<h1 class="pz-moment__title medium karnak">Solve Replay</h1>
							<div style="display: flex; justify-content: center; align-items: center; flex: 1 1 auto; min-height: 120px; margin: 16px 0;">
								<canvas id="xwd-replay-canvas"
									style="max-width: 100%; max-height: 100%; border: 1px solid #ccc; border-radius: 4px;">
								</canvas>
								<canvas id="xwd-replay-encoder" aria-hidden="true"
									style="position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none;">
								</canvas>
							</div>
							<p style="text-align: center; color: #666; font-size: 14px; margin: 8px 0;">
								${mutationTracker.length} moves recorded
							</p>
							<div style="width: 100%; max-width: 360px; margin: 8px 0 28px; font-size: 14px;">
								<label for="xwd-replay-fps" style="display: block; text-align: center; font-weight: 700; margin-bottom: 6px;">Playback Speed</label>
								<div style="display: flex; align-items: center; gap: 10px;">
									<span aria-hidden="true">${SLIDER_MIN_FPS} fps</span>
									<div style="position: relative; flex: 1;">
										<input type="range" id="xwd-replay-fps" min="${SLIDER_MIN_FPS}" max="${SLIDER_MAX_FPS}" step="1" value="${SLIDER_DEFAULT_FPS}"
											aria-valuetext="${SLIDER_DEFAULT_FPS} fps" style="display: block; width: 100%; margin: 0; accent-color: #000; cursor: pointer;">
										<output id="xwd-replay-fps-value" for="xwd-replay-fps" style="position: absolute; top: calc(100% + 4px); transform: translateX(-50%); white-space: nowrap;">
											${SLIDER_DEFAULT_FPS} fps
										</output>
									</div>
									<span aria-hidden="true">${SLIDER_MAX_FPS} fps</span>
								</div>
							</div>
							<div class="xwd__modal--button-container">
								<button type="button" id="xwd-replay-download" class="pz-moment__button primary default" disabled
									style="opacity: 0.5; pointer-events: none; width: auto; max-width: none; padding-inline: 24px; white-space: nowrap;">
									Encoding WebM...
								</button>
							</div>
						</article>
					</div>
				</div>
			</div>
		`;
		const modalContainer = document.getElementById('portal-game-modals') ?? document.body;
		modalContainer.appendChild(menuDiv);

		const modalBody = menuDiv.querySelector('.xwd__modal--body');
		let isClosing = false;
		const closeMenuCallback = async () => {
			if (isClosing) return; // ignore extra clicks during the close animation
			isClosing = true;
			document.removeEventListener('keydown', closeOnEscape);
			modalBody.classList.add('closing');
			await Promise.race([
				new Promise(resolve => modalBody.addEventListener('animationend', resolve, { once: true })),
				sleep(MENU_ANIMATION_MS + 100), // fallback in case the animation doesn't run
			]);
			isMenuOpen = false;
			menuDiv.remove();
			if (button) {
				button.disabled = false;
			}
		};
		menuDiv.querySelector('#xwd-replay-close')?.addEventListener('click', closeMenuCallback);
		menuDiv.querySelector('#xwd-replay-overlay')?.addEventListener('click', closeMenuCallback);
		const closeOnEscape = (event) => {
			if (event.key === 'Escape') closeMenuCallback();
		};
		document.addEventListener('keydown', closeOnEscape);

		const replayCanvas = menuDiv.querySelector('#xwd-replay-canvas');
		const downloadBtn = menuDiv.querySelector('#xwd-replay-download');
		
		const fpsSlider = menuDiv.querySelector('#xwd-replay-fps');
		const fpsValue = menuDiv.querySelector('#xwd-replay-fps-value');
		const encoderCanvas = menuDiv.querySelector('#xwd-replay-encoder');

		// Abort playback/encoding after menu close
		const isStopped = () => !menuDiv.isConnected;

		// Preview plays continuously at the slider's live value
		const updateFpsLabel = () => {
			const fraction = (fpsSlider.value - fpsSlider.min) / (fpsSlider.max - fpsSlider.min);
			fpsValue.textContent = fpsSlider.ariaValueText = `${fpsSlider.value} fps`;
			fpsValue.style.left = `calc(${fraction * 100}% + ${8 - fraction * 16}px)`;
		};
		updateFpsLabel();
		fpsSlider.addEventListener('input', updateFpsLabel);
		createCanvasPlayer(replayCanvas, () => 1000 / Number(fpsSlider.value), isStopped);

		// Encode once at SLIDER_MAX_FPS on the hidden canvas; downloads are retimed to the slider's value
		const onEncodingFinished = (videoBlob) => {
			if (!videoBlob || videoBlob.size <= 200) { // <= 200 bytes means header only, missing frame data
				console.debug(EXTENSION_NAME, METHOD_NAME, '[ERROR] WebM blob missing or too small:', videoBlob?.size);
				downloadBtn.textContent = 'Encoding failed';
				return;
			}
			const blobSizeKB = (videoBlob.size / 1024).toFixed(1);
			downloadBtn.textContent = `Download WebM (${blobSizeKB} KB)`;
			downloadBtn.disabled = false;
			downloadBtn.style.removeProperty('opacity');
			downloadBtn.style.removeProperty('pointer-events');
			downloadBtn.addEventListener('click', async () => {
				const puzzleDate = getPuzzleDate();
				const rescaledVideoBlob = await rescaleWebmTimecodes(videoBlob, SLIDER_MAX_FPS / Number(fpsSlider.value));
				downloadBlob(rescaledVideoBlob, `nyt-crossword-replay-${puzzleDate}.webm`);
			});
			console.debug(EXTENSION_NAME, METHOD_NAME, '[INFO] WebM ready for download');
		};
		recordCanvasToWebm(encoderCanvas, 1000 / SLIDER_MAX_FPS, isStopped, onEncodingFinished);
	} catch (e) {
		console.error(EXTENSION_NAME, 'Replay failed:', e);
		isMenuOpen = false;
		if (button) {
			button.disabled = false;
		}
	}
}

/**
 * Inject replay menu button into tools container HTML. No-op if the toolbar
 * isn't rendered yet or the button already exists.
 */
function injectReplayButton() {
	const toolsContainer = document.querySelector('.xwd__header--tools-container');
	if (!toolsContainer) return;
	const BUTTON_ID = 'xwd-replay-button'
	if (document.getElementById(BUTTON_ID)) return; // button already exists

	const buttonHTML = `
		<button type="button" id="xwd-replay-button" class="xwd__printtools--button">
			<img src="${chrome.runtime.getURL('icon128-full.png')}" alt="" aria-hidden="true" width="20" height="20">
			<span class="xwd__printtools--text">Replay</span>
		</button>
	`;
	toolsContainer.insertAdjacentHTML('beforeend', buttonHTML);
	// Lay out Print and Replay side by side. NYT's button styles stack tools vertically:
	// each button is width: 100% with margin-bottom on all but the last child, so once
	// Replay is appended Print gets a bottom margin that would push it out of line.
	document.head.insertAdjacentHTML('beforeend', `
		<style id="xwd-replay-styles">
			.xwd__header--tools-container:has(#xwd-replay-button) {
				display: flex;
				gap: calc(var(--horizontal-spacing-0-5, 4px) * 3.75);
			}
			.xwd__header--tools-container:has(#xwd-replay-button) .xwd__printtools--button {
				margin-bottom: 0;
			}
		</style>
	`);

	document.getElementById(BUTTON_ID)?.addEventListener('click', showReplayMenu);
}

/**
 * Async helper to gzip a string and encode it as base64.
 */
async function getCompressedString(text) {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	const binary = bytes.reduce((acc, cur) => acc + String.fromCharCode(cur), '');
	return btoa(binary);
}

/**
 * Async helper to decode a base64 string and decompress with gzip.
 */
async function decodeCompressedString(base64) {
	const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).text();
}

/**
 * Writes the puzzle state (originalGridSvgString, mutationTracker) to disk
 */
async function writeRecordToDisk() {
	// Reset the stored svg only after grid clear
	if (needToResetStoredSvg) {
		needToResetStoredSvg = false;
		compressedSvg = await getCompressedString(originalGridSvgString);
	}
	// Convert frames of objects to frames of [row, col, value] tuples for better compression
	const frameTuples = mutationTracker.map(frame => frame.map(({ row, col, value }) => [row, col, value]));
	const mutations = await getCompressedString(JSON.stringify(frameTuples));
	await chrome.storage.local.set({
		[recordKey]: {
			svg: compressedSvg,
			mutations,
			lastUpdatedTimestamp: Date.now(),
		}
	});
}

/**
 * Load puzzle record from storage if one exists. Otherwise writes a new
 * record from the current state. Calls `onSuccessCallback` if storage is accessible.
 */
async function loadOrCreateRecord(onSuccessCallback) {
	const METHOD_NAME = 'loadOrCreateRecord';
	try {
		recordKey = `${PUZZLE_RECORD_PREFIX}${getPuzzleDate()}`;
		const record = (await chrome.storage.local.get(recordKey))[recordKey];
		if (record) {
			const storedSvg = await decodeCompressedString(record.svg);
			const storedTuples = JSON.parse(await decodeCompressedString(record.mutations));
			originalGridSvgString = storedSvg;
			compressedSvg = record.svg;
			needToResetStoredSvg = false;
			// Keep any moves made while the record was loading
			mutationTracker = storedTuples.map(frame => frame.map(([row, col, value]) => ({ row, col, value }))).concat(mutationTracker);
			console.debug(EXTENSION_NAME, METHOD_NAME, `[INFO] Loaded ${recordKey} with ${storedTuples.length} moves`);
		} else {
			await writeRecordToDisk();
			hasUnsavedMutations = false;
			console.debug(EXTENSION_NAME, METHOD_NAME, `[INFO] Created ${recordKey}`);
		}
	} catch (e) {
		console.error(EXTENSION_NAME, '[ERROR] could not access local storage', e);
		return;
	}
	onSuccessCallback();
}

/**
 * Start interval timer to periodically flush new grid mutations to storage 
 * indefinetly until `recordMutationsToDisk` is false.
 */
function startFlushingMutationsToDisk(intervalMs) {
	recordMutationsToDisk = true;
	const flushMutationsToDisk = async () => {
		if (!recordMutationsToDisk) return;
		if (hasUnsavedMutations) {
			// set immediantly and reset on failure to capture mutations made while writeRecordToDisk waits
			hasUnsavedMutations = false;
			try {
				await writeRecordToDisk();
			} catch (e) {
				// Retry next attempt
				hasUnsavedMutations = true;
				console.debug(EXTENSION_NAME, METHOD_NAME, '[ERROR] failed to save mutations:', e);
			}
		}
		setTimeout(flushMutationsToDisk, intervalMs);
	};
	setTimeout(flushMutationsToDisk, intervalMs);
}

/**
 * Purges puzzle records in order of lastUpdatedTimestamp (oldest first) until
 * total storage use is under storageBudgetBytes. Never purges current record.
 */
async function purgeOldRecords(storageBudgetBytes) {
	const METHOD_NAME = 'purgeOldRecords';
	try {
		const bytesInUse = await chrome.storage.local.getBytesInUse(null /* keys */);
		const bytesToRemove = bytesInUse - storageBudgetBytes;
		if (bytesToRemove <= 0) return;

		const allItems = await chrome.storage.local.get(null /* keys */);
		const oldestFirst = Object.entries(allItems)
			.filter(([key, _value]) => key.startsWith(PUZZLE_RECORD_PREFIX) && key !== recordKey)
			.sort(([_ka, a], [_kb, b]) => (a.lastUpdatedTimestamp ?? 0) - (b.lastUpdatedTimestamp ?? 0));

		const keysToRemove = [];
		let bytesRemoved = 0;
		for (const [key, record] of oldestFirst) {
			if (bytesRemoved >= bytesToRemove) break;
			keysToRemove.push(key);
			// Chrome counts each item as key length + JSON length of its value
			bytesRemoved += key.length + JSON.stringify(record).length;
		}
		await chrome.storage.local.remove(keysToRemove);
		console.debug(EXTENSION_NAME, METHOD_NAME, `[INFO] Purged ${keysToRemove.length} records, ~${((bytesInUse-bytesRemoved)/1024).toFixed(1)} KB in use`);
	} catch (e) {
		console.error(EXTENSION_NAME, '[ERROR] failed to purge old records:', e);
	}
}

let loadCheckAttempts = 0;
const MAX_LOAD_CHECK_ATTEMPTS = 1000;
/**
 * Observer function to trigger on document updates until the xwd grid is
 * loaded. Then captures the initial grid snapshot, starts recording cell
 * mutations, and injects the replay button. Gives up after
 * MAX_LOAD_CHECK_ATTEMPTS updates.
 */
const onGridLoad = (_mutationsList, observer) => {
	const gridSvgElement = document.getElementById('xwd-board');
	if (gridSvgElement) {
		// Attach cell mutation observer
		gridObserver.observe(gridSvgElement, gridObserverConfig);
		observer.disconnect();

		// Capture initial grid state
		if (!originalGridSvgString) {
			originalGridSvgString = captureGridSnapshot(gridSvgElement);
		}

		// Restore saved record for this puzzle, or save the new snapshot
		// Start recording grid mutations to disk if disk is accessible.
		loadOrCreateRecord(() => { /* onSuccessCallback */
			startFlushingMutationsToDisk(PERSIST_INTERVAL_MS);
			purgeOldRecords(STORAGE_BUDGET_BYTES);
		});

		// Inject the replay button
		injectReplayButton();
		console.log(EXTENSION_NAME, 'Grid loaded, recording started');
	}

	if (++loadCheckAttempts > MAX_LOAD_CHECK_ATTEMPTS) {
		console.error(EXTENSION_NAME, 'failed to find grid after', MAX_LOAD_CHECK_ATTEMPTS, 'attempts');
		observer.disconnect();
	}
};

const gridLoadObserver = new MutationObserver(onGridLoad);
gridLoadObserver.observe(document, {
	attributes: false,
	childList: true,
	characterData: true,
	subtree: true,
});
