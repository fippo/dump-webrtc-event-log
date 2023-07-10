// See (static) DecodeVarInt
function _decodeVarInt(reader) {
    let decoded = 0n;
    for (let i = 0; i < 10; i++) {
        const byte = reader.ReadBits(8);
        decoded += byte << BigInt(7 * i);
        if (!(BigInt.asUintN(1, byte) & BigInt(0x80))) {
            return decoded;
        }
    }
    console.error('decodeVarInt failed.');
}

// Modelled after libWebRTC bitstream reader and  delta encoder.
// https://source.chromium.org/chromium/chromium/src/+/refs/heads/main:third_party/webrtc/rtc_base/bitstream_reader.h;drc=afec9eaf1d11cc77e8e06f06cb026fadf0dbf758;l=30
// TODO: add invalidation flag to help deal with parsing errors.
class BitstreamReader {
    constructor(data) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.offset = 0;
        this.remainingBits = data.byteLength * 8;
    }

    ReadBits(bits) {
        bits = Number(bits);
        if (this.remainingBits < bits) {
            console.error('Out of bounds in bitstream reader');
            return -1n;
        }
        const remainingBitsInFirstByte = this.remainingBits % 8;
        this.remainingBits -= bits;
        if (bits < remainingBitsInFirstByte) {
            // Can be handled in current byte.
            const offset = remainingBitsInFirstByte - bits;
            return BigInt((this.view.getUint8(this.offset) >> offset) & ((1 << bits) - 1));
        }
        let result = 0n;
        if (remainingBitsInFirstByte > 0) {
            bits -= remainingBitsInFirstByte;
            const mask = (1 << remainingBitsInFirstByte) - 1;
            result = BigInt(this.view.getUint8(this.offset) & mask) << BigInt(bits);
            this.offset++;
        }
        while(bits >= 8) {
            bits -= 8;
            result |= BigInt(this.view.getUint8(this.offset)) << BigInt(bits);
            this.offset++;
        }
        if (bits > 0) {
            result |= BigInt(this.view.getUint8(this.offset)) >> BigInt(8 - bits);
        }
        return result;
    }
}

// Based on delta_encoding.cc:
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/webrtc/logging/rtc_event_log/encoder/delta_encoding.cc;l=807;drc=277766f55efc7ba37fbaa3a9f86ba36e9adb94f0
class FixedLengthDeltaDecoder {
    constructor(data, base, numberOfDeltas) {
        this.base = base;
        this.numberOfDeltas = numberOfDeltas;
        if (data.buffer) {
            this.reader = new BitstreamReader(data);
        } else {
            return;
        }

        const encodingType = this.reader.ReadBits(2);
        this.params = {};
        this.params.deltaWidthBits = this.reader.ReadBits(6) + 1n;
        if (encodingType === 0n) {
            this.params.signedDeltas = false;
            this.params.valuesOptional = false;
            this.params.valueWidthBits = 64n;
        } else if (encodingType === 1n) {
            this.params.signedDeltas = this.reader.ReadBits(1) != 0n;
            this.params.valuesOptional = this.reader.ReadBits(1) != 0n;
            this.params.valueWidthBits = this.reader.ReadBits(6) + 1n;
        } else {
            console.error('Unsupported format');
        }
    }

    // See FixedLengthDeltaDecoder::Decode
    decode() {
        if (!this.reader) {
            return (new Array(this.numberOfDeltas)).fill(this.base);
        }
        const existingValues = new Array(this.numberOfDeltas);
        if (this.params.valuesOptional) {
            for (let i = 0; i < this.numberOfDeltas; i++) {
                existingValues[i] = !!this.reader.ReadBits(1);
            }
        } else {
            existingValues.fill(true);
        }
        let previous = this.base;
        const values = new Array(this.numberOfDeltas);
        for (let i = 0; i < this.numberOfDeltas; i++) {
            if (!existingValues[i]) continue;
            if (previous === undefined) {
                values[i] = _decodeVarInt(this.reader);
            } else {
                const delta = this.reader.ReadBits(this.params.deltaWidthBits);
                values[i] = this.applyDelta(previous, delta);
            }
            previous = values[i];
        }
        // this.reader.remainingBits can be > 0? Probably...
        // console.log('REMAINING', this.reader.remainingBits);
        return values;
    }

    // See FixedLengthDeltaDecoder::ApplyDelta
    applyDelta(base, delta) {
        if (this.params.signedDeltas) {
            const topBit = 1n << (this.params.deltaWidthBits - 1n);
            const positive = (delta & topBit) === 0n;
            if (positive) {
                return BigInt.asUintN(Number(this.params.valueWidthBits), base + delta);
            }
            const deltaAbs = BigInt.asUintN(Number(this.params.deltaWidthBits), ~delta) + 1n;
            return BigInt.asUintN(Number(this.params.valueWidthBits), base - deltaAbs);
        } else {
            return BigInt.asUintN(Number(this.params.valueWidthBits), base + delta);
        }
    }
}

// Based on blob_encoding.cc:
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/webrtc/logging/rtc_event_log/encoder/blob_encoding.cc;l=48?q=blob_encoding.cc&ss=chromium%2Fchromium%2Fsrc
class BlobDecoder {
    constructor(data, numberOfDeltas) {
        this.reader = new BitstreamReader(data);
        this.data = data;
        this.numberOfDeltas = numberOfDeltas;
    }
    // See DecodeBlobs
    decode() {
        const lengths = new Array(this.numberOfDeltas);
        const values = new Array(this.numberOfDeltas);
        for (let i = 0; i < this.numberOfDeltas; i++) {
            lengths[i] = Number(_decodeVarInt(this.reader));
        }
        let offset = this.reader.offset;
        for (let i = 0; i < this.numberOfDeltas; i++) {
            values[i] = new Uint8Array(this.data.buffer, this.data.byteOffset + offset, lengths[i]);
            offset += lengths[i];
        }
        return values;
    }
}