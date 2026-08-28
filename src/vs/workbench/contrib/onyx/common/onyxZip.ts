/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A minimal ZIP writer (store-only, no compression) for the diagnostics
 * bundle. Diagnostics are mostly small JSON and log text, written once and
 * read rarely — a dependency-free 100-line writer beats pulling a compression
 * library into the renderer for that. Store-only zips open everywhere.
 */

export interface IOnyxZipEntry {
	/** Forward-slash relative path inside the archive. */
	readonly path: string;
	readonly data: Uint8Array;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

class ByteWriter {
	private readonly _chunks: Uint8Array[] = [];
	private _length = 0;

	get length(): number { return this._length; }

	bytes(data: Uint8Array): void {
		this._chunks.push(data);
		this._length += data.length;
	}

	u16(value: number): void {
		this.bytes(new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]));
	}

	u32(value: number): void {
		this.bytes(new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]));
	}

	concat(): Uint8Array {
		const out = new Uint8Array(this._length);
		let offset = 0;
		for (const chunk of this._chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}

/** Builds a complete store-only ZIP archive from the given entries. */
export function createStoredZip(entries: readonly IOnyxZipEntry[]): Uint8Array {
	const writer = new ByteWriter();
	const encoder = new TextEncoder();
	const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

	for (const entry of entries) {
		const name = encoder.encode(entry.path);
		const crc = crc32(entry.data);
		const offset = writer.length;
		writer.u32(0x04034B50);          // local file header signature
		writer.u16(20);                  // version needed
		writer.u16(0);                   // flags
		writer.u16(0);                   // method: store
		writer.u16(0); writer.u16(0);    // mod time/date (epoch — diagnostics carry their own timestamps)
		writer.u32(crc);
		writer.u32(entry.data.length);   // compressed size (= raw for store)
		writer.u32(entry.data.length);   // uncompressed size
		writer.u16(name.length);
		writer.u16(0);                   // extra length
		writer.bytes(name);
		writer.bytes(entry.data);
		central.push({ name, crc, size: entry.data.length, offset });
	}

	const centralStart = writer.length;
	for (const record of central) {
		writer.u32(0x02014B50);          // central directory signature
		writer.u16(20); writer.u16(20);  // version made by / needed
		writer.u16(0); writer.u16(0);    // flags, method
		writer.u16(0); writer.u16(0);    // time, date
		writer.u32(record.crc);
		writer.u32(record.size);
		writer.u32(record.size);
		writer.u16(record.name.length);
		writer.u16(0); writer.u16(0);    // extra, comment
		writer.u16(0);                   // disk number
		writer.u16(0);                   // internal attrs
		writer.u32(0);                   // external attrs
		writer.u32(record.offset);
		writer.bytes(record.name);
	}
	const centralSize = writer.length - centralStart;

	writer.u32(0x06054B50);              // end of central directory
	writer.u16(0); writer.u16(0);        // disk numbers
	writer.u16(central.length);
	writer.u16(central.length);
	writer.u32(centralSize);
	writer.u32(centralStart);
	writer.u16(0);                       // comment length

	return writer.concat();
}
