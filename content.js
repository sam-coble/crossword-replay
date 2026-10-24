const EXTENSION_NAME = '[crossword-replay]';
console.log(EXTENSION_NAME, 'Extension loaded!');

// Configs
const MAX_HISTORY_SIZE = 1000;
const FRAME_DELAY_MS = 100; // 100ms per move = 10fps

// State
let mutationTracker = [];
let originalGridSvgString = null;

let isMenuOpen = false;

/**
 * Observer function to trigger on all updates of xwd grid, find
 * the updated cell, and append the mutation to history tracker.
 * Should only be triggered on *characterData* update (i.e. not
 * attribute/highlighting change) 
 */
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
 * other elements which break SVG rendering.
 */
function cleanSvgForReplay(svgString) {
	let ret = svgString
		.replace(/xwd__cell--selected/g, '')
		.replace(/xwd__cell--highlighted/g, '')
		.replace(/aria-selected="true"/g, 'aria-selected="false"')
		// Remove <use xlink:href="..."> elements
		.replace(/<use[^>]*xlink:href[^>]*><\/use>/g, '')
		.replace(/<use[^>]*xlink:href[^>]*\/>/g, '');

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
	const updatedCellInner = cellInner.replace(
		/(<text[^>]*text-anchor="middle"[^>]*>)\s*(<text[^>]*class="xwd__cell--hidden"[^>]*>)[^<]*(<\/text>)[^<]*(<\/text>)/,
		`$1$2${value}$3${value}$4`
	);
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
	for (const mutation of mutationTracker) {
		currentSvg = getNextSvg(currentSvg, mutation);
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

/**
 * Starts a looping replay on given canvas by applying and animating grid
 * mutations one at a time. Returns callback to stop asynchronous playback.
 */
async function createCanvasPlayer(canvas, frameDelay = FRAME_DELAY_MS) {
	const METHOD_NAME = 'createCanvasPlayer';
	if (!originalGridSvgString) {
		console.debug(EXTENSION_NAME, METHOD_NAME, 'no frames found');
		return () => {};
	}

	const ctx = canvas.getContext('2d');
	const {width, height} = getGridDimensions();
	canvas.width = width;
	canvas.height = height;
	
	let running = true;
	let animationTimer = null;
	async function startAnimation() {
		while (running) {
			for (const svgString of generateSvgFrames()) {
				if (!running) return;
				try {
					const img = await loadSvgAsImage(svgString);
					ctx.clearRect(0, 0, canvas.width, canvas.height);
					ctx.fillStyle = '#ffffff';
					ctx.fillRect(0, 0, canvas.width, canvas.height);
					ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
				} catch (e) { /* skip failed frame */ }
				await new Promise(r => { animationTimer = setTimeout(r, frameDelay); });
			}
		}
	}

	// Start playing (fire-and-forget async loop)
	startAnimation();

	return () => {
		running = false;
		if (animationTimer) {
			clearTimeout(animationTimer)
		};
	};
}

/**
 * Click handler for the replay menu button. Opens the replay modal, renders the
 * timelapse on a canvas in real-time, and prepares the WebM download in the
 * background. No-op if the modal is already open.
 */
async function showReplayMenu() {
	const METHOD_NAME = 'showReplayMenu';
	if (isMenuOpen) return;
	isMenuOpen = true;

	// Set button inactive
	const button = document.getElementById('xwd-replay-button');
	if (button) {
		button.disabled = true;
	}

	let stopCanvasPlaybackCallback = null;

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
								<button type="button" id="xwd-replay-download" class="pz-moment__button primary default" disabled
									style="opacity: 0.5; pointer-events: none;">
									Encoding WebM...
								</button>
							</div>
						</article>
					</div>
				</div>
			</div>
		`;
		document.body.appendChild(menuDiv);

		// Wire close button and overlay click
		const closeMenuCallback = () => {
			if (stopCanvasPlaybackCallback) {
				stopCanvasPlaybackCallback();
			}
			isMenuOpen = false;
			menuDiv.remove();
			if (button) {
				button.disabled = false;
			}
		};
		menuDiv.querySelector('#xwd-replay-close')?.addEventListener('click', closeMenuCallback);
		menuDiv.querySelector('#xwd-replay-overlay')?.addEventListener('click', closeMenuCallback);

		const replayCanvas = menuDiv.querySelector('#xwd-replay-canvas');
		stopCanvasPlaybackCallback = await createCanvasPlayer(replayCanvas);
		console.debug(EXTENSION_NAME, METHOD_NAME, '[INFO] Canvas player started');
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
			<i class="pz-icon pz-icon-print-black" aria-hidden="true"></i>
			<span class="xwd__printtools--text">Replay</span>
		</button>
	`;
	toolsContainer.insertAdjacentHTML('beforeend', buttonHTML);

	document.getElementById(BUTTON_ID)?.addEventListener('click', showReplayMenu);
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
			const rawSvg = gridSvgElement.cloneNode(true /* deepClone */).outerHTML;
			const styledSvg = getStyledSvg(rawSvg, document.styleSheets, '.xwd__');
			originalGridSvgString = cleanSvgForReplay(styledSvg);
		}

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
