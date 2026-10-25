// Helpers for rewriting WebM (EBML) files produced by MediaRecorder.

// don't really know about how it works -- just kinda trust

function readEbmlVint(bytes, offset) {
	let length = 1;
	while (length < 8 && !(bytes[offset] & (0x80 >> (length - 1)))) length++;
	let value = bytes[offset] & (0xff >> length);
	for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
	return { value, length };
}

function writeEbmlVint(value, length) {
	if (value >= 2 ** (7 * length) - 1) throw new Error(`EBML size ${value} doesn't fit in ${length} bytes`);
	const out = new Uint8Array(length);
	for (let i = length - 1; i >= 0; i--, value = Math.floor(value / 256)) out[i] = value % 256;
	out[0] |= 0x80 >> (length - 1);
	return out;
}

async function rescaleWebmTimecodes(blob, factor) {
	const INFO_ID = 0x1549a966;
	const TIMECODE_SCALE_ID = 0x2ad7b1;
	const DEFAULT_TIMECODE_SCALE = 1_000_000; // 1ms per tick
	const bytes = new Uint8Array(await blob.arrayBuffer());
	// IDs keep their marker bits, so read them as raw big-endian bytes
	const readId = (offset) => {
		const { length } = readEbmlVint(bytes, offset);
		return { id: bytes.slice(offset, offset + length).reduce((acc, b) => acc * 256 + b, 0), length };
	};
	const readElement = (offset) => {
		const id = readId(offset);
		const size = readEbmlVint(bytes, offset + id.length);
		const dataStart = offset + id.length + size.length;
		return { id: id.id, start: offset, sizeOffset: offset + id.length, size, dataStart, end: dataStart + size.value };
	};

	const ebmlHeader = readElement(0);
	const segment = readElement(ebmlHeader.end);
	const isUnknownSize = (size) => size.value === 2 ** (7 * size.length) - 1; // MediaRecorder streams Segment

	// Find Info in Segment, then TimecodeScale in Info
	let info = readElement(segment.dataStart);
	while (info.id !== INFO_ID) info = readElement(info.end);
	let scaleElement = null;
	for (let offset = info.dataStart; offset < info.end && !scaleElement;) {
		const element = readElement(offset);
		if (element.id === TIMECODE_SCALE_ID) scaleElement = element;
		offset = element.end;
	}
	const oldScale = scaleElement
		? bytes.slice(scaleElement.dataStart, scaleElement.end).reduce((acc, b) => acc * 256 + b, 0)
		: DEFAULT_TIMECODE_SCALE;

	// New TimecodeScale element: ID 2A D7 B1, 1-byte size, big-endian value
	let newScale = Math.round(oldScale * factor);
	const valueBytes = [];
	for (; newScale > 0; newScale = Math.floor(newScale / 256)) valueBytes.unshift(newScale % 256);
	const newScaleElement = new Uint8Array([0x2a, 0xd7, 0xb1, 0x80 | valueBytes.length, ...valueBytes]);

	// Replace the existing TimecodeScale, or insert one at the start of Info if absent
	const replaceStart = scaleElement ? scaleElement.start : info.dataStart;
	const replaceEnd = scaleElement ? scaleElement.end : info.dataStart;
	const delta = newScaleElement.length - (replaceEnd - replaceStart);

	// Grow the Info size (and the Segment size, unless unknown) by delta, keeping each size field's length
	const parts = [bytes.slice(0, segment.sizeOffset)];
	parts.push(isUnknownSize(segment.size)
		? bytes.slice(segment.sizeOffset, segment.dataStart)
		: writeEbmlVint(segment.size.value + delta, segment.size.length));
	parts.push(bytes.slice(segment.dataStart, info.sizeOffset));
	parts.push(writeEbmlVint(info.size.value + delta, info.size.length));
	parts.push(bytes.slice(info.dataStart, replaceStart), newScaleElement, bytes.slice(replaceEnd));
	return new Blob(parts, { type: 'video/webm' });
}
