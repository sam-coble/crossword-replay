const EXTENSION_NAME = '[crossword-replay]';
console.log(EXTENSION_NAME, 'Extension loaded!');

// Configs
const MAX_HISTORY_SIZE = 1000;

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

	console.log(mutationTracker);

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

		console.log(originalGridSvgString);
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
