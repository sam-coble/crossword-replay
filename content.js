console.log('crossword-replay extension loaded!');

// === Configuration ===
const MAX_HISTORY_SIZE = 1000;
const FRAME_DELAY_MS = 100; // 100ms per move = 10fps

// === State ===
let mutationTracker = [];
let originalGridSvgString = null;
let isExporting = false;

// === Grid Mutation Observer ===
const onGridUpdate = (mutationsList, observer) => {
	const targetMutation = mutationsList.filter(mut => mut
		?.target
		?.parentElement
		?.attributes
		?.['text-anchor']
		?.nodeValue === 'middle'
	)[0];
	if (!targetMutation) return;

	const newCellValue = targetMutation?.target?.textContent;
	const row = +targetMutation?.target?.parentElement?.parentElement?.ariaRowIndex;
	const col = +targetMutation?.target?.parentElement?.parentElement?.ariaColIndex;
	mutationTracker.push({ row, col, value: newCellValue });

	if (mutationTracker.length >= MAX_HISTORY_SIZE) {
		console.log(`Exceeded max move count (${MAX_HISTORY_SIZE}). Stopping replay capture.`);
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

// === SVG Style Extraction ===
function getStyledSvg(svgString, styleSheets, cssSelectorPrefix) {
	let extractedStyles = '';
	try {
		for (const sheet of styleSheets) {
			try {
				if (!sheet.cssRules) continue;
				for (const rule of sheet.cssRules) {
					if (rule.selectorText && rule.selectorText.includes(cssSelectorPrefix)) {
						extractedStyles += rule.cssText + '\n';
					}
				}
			} catch (e) { /* cross-origin stylesheet, skip */ }
		}
	} catch (err) {
		console.error('Failed reading stylesheets:', err);
	}

	// Escape XML-unsafe characters in CSS to prevent breaking SVG validity.
	// & must be escaped first to avoid double-escaping.
	const safeStyles = extractedStyles
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	const styleBlock = `<style type="text/css">${safeStyles}</style>`;

	// Ensure the SVG has the xmlns attribute (required when loaded as standalone via Blob URL)
	let result = svgString;
	if (!result.includes('xmlns="http://www.w3.org/2000/svg"')) {
		result = result.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
	}
	// Ensure xlink namespace is present (needed for <use xlink:href>)
	if (result.includes('xlink:') && !result.includes('xmlns:xlink')) {
		result = result.replace('<svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
	}

	return result.replace(/(<svg[^>]*>)/i, `$1${styleBlock}`);
}

// === Clean SVG for Replay ===
// Removes selection highlighting, aria-selected states, and elements that
// break standalone SVG rendering. Also adds explicit width/height and
// fixes preserveAspectRatio so the SVG fills the canvas exactly.
function cleanSvgForReplay(svgString) {
	let result = svgString
		.replace(/xwd__cell--selected/g, '')
		.replace(/xwd__cell--highlighted/g, '')
		.replace(/aria-selected="true"/g, 'aria-selected="false"')
		// Remove <use xlink:href="..."> elements that reference in-page defs
		.replace(/<use[^>]*xlink:href[^>]*><\/use>/g, '')
		.replace(/<use[^>]*xlink:href[^>]*\/>/g, '');

	// The NYT SVG has no width/height attributes — only viewBox.
	// When loaded as a standalone image via Blob URL, browsers need explicit
	// width/height to determine intrinsic size. Extract from viewBox.
	const vbMatch = result.match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
	if (vbMatch && !result.match(/<svg[^>]*\bwidth="/)) {
		result = result.replace('<svg', `<svg width="${vbMatch[3]}" height="${vbMatch[4]}"`);
	}

	// Change preserveAspectRatio to "none" so the SVG fills the canvas
	// exactly without centering or letterboxing
	result = result.replace(/preserveAspectRatio="[^"]*"/, 'preserveAspectRatio="xMidYMid meet"');

	return result;
}

// === Apply Mutation to SVG String ===
// Uses the live DOM to find the target cell and produce an updated SVG string.
// We parse into a temporary detached DOM, mutate, and serialize — but we use
// the *page* DOMParser (not XMLSerializer) to avoid namespace mangling:
// we do the mutation via innerHTML surgery on the specific cell's text content.
function getNextSvg(prevSvgString, mutation) {
	const { row, col, value } = mutation;

	// Strategy: find the specific cell's text-anchor="middle" text element using
	// a precise needle string built from the cell's unique attributes, then do
	// a targeted string replacement of just its inner content.

	// Step 1: Build a needle to locate the exact cell opening tag.
	// Use a two-pass approach: find the <g> with exact aria-rowindex="N" and aria-colindex="N"
	// where N is bounded by quote marks (preventing "1" matching "10").
	const cellOpenPattern = new RegExp(
		`<g\\s[^>]*?aria-rowindex="${row}"[^>]*?aria-colindex="${col}"[^>]*?>`,
	);
	const cellOpenPatternAlt = new RegExp(
		`<g\\s[^>]*?aria-colindex="${col}"[^>]*?aria-rowindex="${row}"[^>]*?>`,
	);

	const cellOpenMatch = prevSvgString.match(cellOpenPattern) || prevSvgString.match(cellOpenPatternAlt);
	if (!cellOpenMatch) {
		console.warn(`getNextSvg: cell not found at row=${row}, col=${col}`);
		return prevSvgString;
	}

	// Step 2: From the cell open tag position, find the text-anchor="middle" text element.
	// We know cells don't nest other cells, so we can search forward from the match position.
	const cellStart = cellOpenMatch.index;

	// Find the cell's closing </g> — but we need to handle nesting.
	// Cells contain <text> (not <g>), so the first </g> after the cell open IS the cell close.
	const afterCellOpen = cellStart + cellOpenMatch[0].length;
	const cellCloseIdx = prevSvgString.indexOf('</g>', afterCellOpen);
	if (cellCloseIdx === -1) {
		console.warn(`getNextSvg: couldn't find closing </g> for cell row=${row}, col=${col}`);
		return prevSvgString;
	}

	// Extract just this cell's inner content
	const cellInner = prevSvgString.substring(afterCellOpen, cellCloseIdx);

	// Step 3: Within the cell, replace the text-anchor="middle" text element's content.
	// Pattern: <text ... text-anchor="middle" ...><text class="xwd__cell--hidden">OLD</text>OLD</text>
	const updatedCellInner = cellInner.replace(
		/(<text[^>]*text-anchor="middle"[^>]*>)\s*(<text[^>]*class="xwd__cell--hidden"[^>]*>)[^<]*(<\/text>)[^<]*(<\/text>)/,
		`$1$2${value}$3${value}$4`
	);

	if (updatedCellInner === cellInner) {
		console.warn(`getNextSvg: text element not found in cell row=${row}, col=${col}`);
	}

	// Step 4: Reconstruct the full SVG with the updated cell
	return prevSvgString.substring(0, afterCellOpen) + updatedCellInner + prevSvgString.substring(cellCloseIdx);
}

// === Build SVG Frame Array from Mutations ===
function buildSvgFrames() {
	if (!originalGridSvgString) {
		console.error('No initial grid snapshot captured');
		return [];
	}

	const frames = [originalGridSvgString]; // Frame 0: initial state
	let currentSvg = originalGridSvgString;

	for (const mutation of mutationTracker) {
		currentSvg = getNextSvg(currentSvg, mutation);
		frames.push(currentSvg);
	}

	return frames;
}

// === SVG String → Image Promise ===
function loadSvgAsImage(svgString) {
	return new Promise((resolve, reject) => {
		// Safety: ensure xmlns is present for standalone SVG
		let safeSvg = svgString;
		if (!safeSvg.includes('xmlns="http://www.w3.org/2000/svg"')) {
			safeSvg = safeSvg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
		}

		const img = new Image();
		const blob = new Blob([safeSvg], { type: 'image/svg+xml;charset=utf-8' });
		const url = URL.createObjectURL(blob);

		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = (err) => {
			URL.revokeObjectURL(url);
			console.error('SVG image load failed. First 500 chars:', safeSvg.substring(0, 500));
			reject(new Error('SVG failed to load as image'));
		};
		img.src = url;
	});
}

// === Record a canvas player's output to WebM ===
// Attaches MediaRecorder to a canvas that is already in the DOM and being
// animated by the canvas player. Records one full loop of the animation.
async function recordCanvasToWebm(canvas, svgFrames, frameDelay = FRAME_DELAY_MS) {
	console.log(`Recording ${svgFrames.length} frames from live canvas...`);

	const stream = canvas.captureStream(0);
	const track = stream.getVideoTracks()[0];

	// Pick best codec
	let mimeType = 'video/webm';
	for (const candidate of ['video/webm; codecs=vp9', 'video/webm; codecs=vp8', 'video/webm']) {
		if (MediaRecorder.isTypeSupported(candidate)) { mimeType = candidate; break; }
	}
	console.log(`Recording codec: ${mimeType}`);

	const recorder = new MediaRecorder(stream, {
		mimeType,
		videoBitsPerSecond: 5_000_000,
	});

	const chunks = [];
	recorder.ondataavailable = (e) => {
		if (e.data && e.data.size > 0) chunks.push(e.data);
	};

	const recordingFinished = new Promise((resolve) => {
		recorder.onstop = () => {
			resolve(new Blob(chunks, { type: 'video/webm' }));
		};
	});

	// Start recording
	recorder.start(1000);

	// Render each frame once to the canvas (one full playthrough, not looping)
	const ctx = canvas.getContext('2d');
	for (let i = 0; i < svgFrames.length; i++) {
		try {
			const img = await loadSvgAsImage(svgFrames[i]);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

			// Force composite + capture
			await new Promise(r => requestAnimationFrame(r));
			track.requestFrame();
			await new Promise(r => setTimeout(r, frameDelay));
		} catch (error) {
			console.warn(`Record: skipped frame ${i}:`, error);
		}

		if (i > 0 && i % 50 === 0) {
			console.log(`Recorded ${i}/${svgFrames.length} frames...`);
		}
	}

	// Hold last frame
	for (let i = 0; i < 3; i++) {
		await new Promise(r => requestAnimationFrame(r));
		track.requestFrame();
		await new Promise(r => setTimeout(r, frameDelay));
	}

	recorder.stop();
	const blob = await recordingFinished;
	console.log(`WebM recorded: ${(blob.size / 1024).toFixed(1)} KB`);
	return blob;
}

// === Download Blob ===
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

// === Get Puzzle Date from URL ===
function getPuzzleDate() {
	const match = window.location.pathname.match(/\/daily\/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
	if (match) {
		return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
	}
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// === Canvas Replay Player ===
// Preloads all SVG frames as Image objects, then plays them on a canvas in a loop.
// Returns a controller object with stop() to clean up the animation loop.
async function createCanvasPlayer(canvas, svgFrames, frameDelay = FRAME_DELAY_MS) {
	const ctx = canvas.getContext('2d');

	// Preload all frames as Image objects
	const images = [];
	for (let i = 0; i < svgFrames.length; i++) {
		try {
			const img = await loadSvgAsImage(svgFrames[i]);
			images.push(img);
		} catch (e) {
			console.warn(`Canvas player: skipped frame ${i}`, e);
		}
	}

	if (images.length === 0) {
		console.error('Canvas player: no frames loaded');
		return { stop() {} };
	}

	// Set canvas size from viewBox or first image
	const vbMatch = svgFrames[0].match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
	if (vbMatch) {
		canvas.width = Math.ceil(parseFloat(vbMatch[3]));
		canvas.height = Math.ceil(parseFloat(vbMatch[4]));
	} else {
		canvas.width = images[0].naturalWidth || 501;
		canvas.height = images[0].naturalHeight || 501;
	}

	let currentFrame = 0;
	let running = true;
	let animationTimer = null;

	function drawFrame() {
		if (!running) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(images[currentFrame], 0, 0, canvas.width, canvas.height);
		currentFrame = (currentFrame + 1) % images.length;
		animationTimer = setTimeout(drawFrame, frameDelay);
	}

	// Start playing
	drawFrame();

	return {
		stop() {
			running = false;
			if (animationTimer) clearTimeout(animationTimer);
		}
	};
}

// === Show Replay Modal (Hybrid) ===
// Shows canvas player immediately, encodes WebM in background for download.
async function showReplayModal() {
	if (isExporting) return;

	if (mutationTracker.length === 0) {
		alert('No moves recorded yet! Start solving the puzzle first.');
		return;
	}

	isExporting = true;
	const button = document.getElementById('xwd-replay-button');
	const buttonText = button?.querySelector('.xwd__printtools--text');
	if (buttonText) buttonText.textContent = 'Loading...';
	if (button) button.disabled = true;

	let player = null;

	try {
		const frames = buildSvgFrames();
		console.log(`Built ${frames.length} SVG frames`);

		// Build and show the modal immediately with a canvas player
		const modalContainer = document.getElementById('portal-game-modals');
		if (!modalContainer) {
			console.error('Modal container not found');
			return;
		}

		const modalDiv = document.createElement('div');
		modalDiv.id = 'xwd-replay-modal';
		modalDiv.innerHTML = `
			<div role="dialog" aria-modal="true" class="modal-system-container" data-testid="modal-wrapper" aria-label="Solve Replay">
				<div class="xwd__modal--wrapper">
					<div class="xwd__modal--overlay" id="xwd-replay-overlay"></div>
					<div class="xwd__modal--body xwd__print-modal--body" tabindex="0" data-testid="modal-body" style="--modal-animation-duration: 200ms;">
						<button type="button" aria-label="close" class="xwd__modal--close" id="xwd-replay-close">
							<i class="pz-icon pz-icon-close"></i>
						</button>
						<article class="xwd__modal--content">
							<h1 class="pz-moment__title medium karnak">Solve Replay</h1>
							<div style="display: flex; justify-content: center; margin: 16px 0;">
								<canvas id="xwd-replay-canvas"
									style="max-width: 100%; max-height: 400px; border: 1px solid #ccc; border-radius: 4px;">
								</canvas>
							</div>
							<p style="text-align: center; color: #666; font-size: 14px; margin: 8px 0;">
								${mutationTracker.length} moves recorded
							</p>
							<div class="xwd__modal--button-container">
								<button type="button" id="xwd-replay-download" class="pz-moment__button primary default" disabled>
									Encoding WebM...
								</button>
							</div>
						</article>
					</div>
				</div>
			</div>
		`;

		modalContainer.appendChild(modalDiv);

		// Wire close button and overlay click
		const closeModal = () => {
			if (player) player.stop();
			modalDiv.remove();
		};
		document.getElementById('xwd-replay-close')?.addEventListener('click', closeModal);
		document.getElementById('xwd-replay-overlay')?.addEventListener('click', closeModal);

		// Start the canvas player immediately
		const replayCanvas = document.getElementById('xwd-replay-canvas');
		player = await createCanvasPlayer(replayCanvas, frames);
		console.log('Canvas player started');

		// Reset button text now that the preview is showing
		if (buttonText) buttonText.textContent = 'Replay';
		if (button) button.disabled = false;
		isExporting = false;

		// Encode WebM in the background by recording the canvas (which is in the DOM)
		const downloadBtn = document.getElementById('xwd-replay-download');
		try {
			// Pause the player animation while we record a clean single playthrough
			player.stop();
			const videoBlob = await recordCanvasToWebm(replayCanvas, frames);
			// Restart the player loop after recording
			player = await createCanvasPlayer(replayCanvas, frames);

			if (videoBlob && videoBlob.size > 200 && downloadBtn) {
				downloadBtn.textContent = 'Download WebM';
				downloadBtn.disabled = false;
				downloadBtn.addEventListener('click', () => {
					downloadBlob(videoBlob, `nyt-crossword-replay-${getPuzzleDate()}.webm`);
				});
				console.log('WebM ready for download');
			} else {
				if (downloadBtn) downloadBtn.textContent = 'Encoding failed';
				console.error('WebM blob too small:', videoBlob?.size);
			}
		} catch (encodeErr) {
			console.error('WebM encoding failed:', encodeErr);
			if (downloadBtn) {
				downloadBtn.textContent = 'Encoding failed';
			}
		}

	} catch (err) {
		console.error('Replay failed:', err);
		alert('Failed to generate replay. Check console for details.');
		isExporting = false;
		if (buttonText) buttonText.textContent = 'Replay';
		if (button) button.disabled = false;
	}
}

// === Inject Replay Button into Toolbar ===
function injectReplayButton() {
	const toolsContainer = document.querySelector('.xwd__header--tools-container');
	if (!toolsContainer) return false;

	// Avoid duplicate injection
	if (document.getElementById('xwd-replay-button')) return true;

	// Match the Print button's exact structure:
	// <button class="xwd__printtools--button"><i class="pz-icon ..."></i><span class="xwd__printtools--text">Print</span></button>
	const buttonHTML = `
		<button type="button" id="xwd-replay-button" class="xwd__printtools--button">
			<i class="pz-icon pz-icon-print-black" aria-hidden="true"></i>
			<span class="xwd__printtools--text">Replay</span>
		</button>
	`;
	toolsContainer.insertAdjacentHTML('beforeend', buttonHTML);

	document.getElementById('xwd-replay-button')?.addEventListener('click', showReplayModal);
	return true;
}

// === Grid Load Observer ===
let loadCheckAttempts = 0;
const MAX_LOAD_CHECK_ATTEMPTS = 100;

const onGridLoad = (_mutationsList, observer) => {
	const gridSvgElement = document.getElementById('xwd-board');
	if (gridSvgElement) {
		// Attach cell mutation observer
		gridObserver.observe(gridSvgElement, gridObserverConfig);
		observer.disconnect();

		// Capture initial grid state (cleaned of selection state)
		if (!originalGridSvgString) {
			const rawSvg = gridSvgElement.cloneNode(true).outerHTML;
			const styledSvg = getStyledSvg(rawSvg, document.styleSheets, '.xwd__');
			originalGridSvgString = cleanSvgForReplay(styledSvg);
		}

		// Inject the replay button
		injectReplayButton();
		console.log('Crossword replay: grid loaded, recording started');
	}

	if (++loadCheckAttempts > MAX_LOAD_CHECK_ATTEMPTS) {
		console.error('Crossword replay: failed to find grid after', MAX_LOAD_CHECK_ATTEMPTS, 'attempts');
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
