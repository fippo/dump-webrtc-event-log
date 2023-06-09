// RTCP helper.
class RTCP {
    // Payload type constants.
    static PT_SR = 200;
    static PT_RR = 201;
    static PT_SDES = 202;
    static PT_BYE = 203;
    static PT_APP = 204;
    static PT_RTPFB = 205;
    static PT_PSFB = 206;
    static PT_XR = 207;
    // Feedback message type constants.
    static FMT_FIR = 4;
    static FMT_NACK = 1;
    static FMT_PLI = 1;
    static FMT_ALFB = 15;
    static FMT_TMMBR = 3;
    static FMT_TMMBN = 4;

    // Parses a single RTCP packet. Iterate this function if multiple RTCP
    // packets are in the same UDP packet (i.e. compound packet).
    static _parse(packet, offset = 0) {
        const view = new DataView(packet.buffer, packet.byteOffset + offset, packet.byteLength - offset);
        if (packet.length < offset + 8) {
            return;
        }
        const first = view.getUint8(0);
        if (first >> 6 !== 2) {
            return;
        }
        return {
            version: first >> 6,
            padding: first >> 5 & 1,
            reportCounter: first & 0x1f, // for SR/RR
            feedbackMessageType: first & 0x1f, // for RTPFB/PSFB
            payloadType: view.getUint8(1),
            length: view.getUint16(2),
            synchronizationSource: view.getUint32(4),
        };
    }

    /*
    * Apply a list of filters to the packet.
    * Each filter is an object specifying
    * * a payloadType the filter applies to (may be undefined)
    * * a feedbackMessageType the filter applies to (may be undefined)
    * * a filter method
    * If the payloadType is undefined or matches the decoded payloadType,
    * the filter method is called with
    * * the decoded RTCP packet,
    * * the raw packet,
    * * the offset of the RTCP packet,
    * * the length of the RTCP packet.
    * The filter must not change the packet but may change the packet content.
    */
    static forEach(packet, ...filters) {
        let offset = 0;
        while (offset < packet.length) {
            if (offset + 8 > packet.length) { // the minimum length is 8 bytes.
                return false;
            }
            const decoded = RTCP._parse(packet, offset);
            if (!decoded) {
                return false;
            }
            const length = 4 * (decoded.length + 1);
            // sanity-check for the length.
            if (offset + length > packet.length) {
                return false;
            }
            for (let i = 0; i < filters.length; i++) {
                const {payloadType, feedbackMessageType} = filters[i];
                if ((payloadType === undefined || payloadType === decoded.payloadType) &&
                (feedbackMessageType === undefined || feedbackMessageType === decoded.feedbackMessageType)) {
                    filters[i].filter(decoded, packet, offset, length);
                }
            }
            offset += length;
        }
        return true;
    }

    static decodeTransportCC(packet, offset) {
        if (packet.length < offset + 20) {
            console.error('overflow in transport-cc');
            return;
        }
        const view = new DataView(packet.buffer, packet.byteOffset + offset, packet.byteLength - offset);

        const baseSequenceNumber = view.getUint16(12);
        let count = view.getUint16(14);
        const referenceTime_ms = (view.getInt32(16) >> 8) * 64;
        const feedbackPacketIndex = view.getUint8(16 + 3);
        const result = {
            baseSequenceNumber,
            referenceTime_ms,
            feedbackPacketIndex,
            delta: new Array(count),
        };

        offset = 20;
        const delta_sizes = [];
        const chunks = [];
        while(delta_sizes.length < result.delta.length) {
            if (offset + 2 > view.byteLength) {
                console.error('overflow in transport-cc');
                return;
            }
            const chunk = view.getUint16(offset);
            chunks.push(chunk);
            if (chunk & 0x8000) {
                // https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01#section-3.1.4
                // Note that we can get at most count chunks
                if (chunk & 0x4000) {
                    // Two bit variant.
                    for (let i = 0; i < Math.min(count, 7); i++) {
                        delta_sizes.push((chunk >> (2 * (7 - 1 - i)) & 0x03));
                    }
                    count -= Math.min(count, 7);
                } else {
                    // single bit variant.
                    for (let i = 0; i < Math.min(count, 14); i++) {
                        delta_sizes.push((chunk >> (14 - 1 - i)) & 0x01);
                    }
                    count -= Math.min(count, 14);
                }
            } else {
                // https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01#section-3.1.3
                for (let i = 0; i < Math.min(count, chunk & 0x1fff); i++) {
                    delta_sizes.push((chunk >> 13) & 0x03);
                }
                count -= Math.min(count, chunk & 0x1fff);
            }
            offset += 2;
        }
        const recv_delta_size = delta_sizes.reduce((a, b) => a + b, 0);
        if (offset + recv_delta_size > view.byteLength) {
            console.error('overflow in transport-cc');
            return;
        }
        for(let i = 0; i < delta_sizes.length; i++) {
            const delta_size = delta_sizes[i];
            // delta size is the status symbol:
            // https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01#section-3.1.1
            let delta;
            switch(delta_size) {
            case 0:
                delta = false;
                break;
            case 1:
                delta = view.getUint8(offset) * 250;
                break;
            case 2:
                delta = view.getInt16(offset) * 250;
                break;
            default:
                console.log('TODO', delta_size);
                break;
            }
            result.delta[i] = delta;
            offset += delta_size;
        }
        return result;
    }

    static decodeReceiverReportBlocks(packet, offset, isSr) {
        const view = new DataView(packet.buffer, packet.byteOffset + offset, packet.byteLength - offset);
        if (packet.length < offset + (isSr ? 28 : 8)) {
            console.error('overflow in report block parsing');
            return;
        }
        const decoded = RTCP._parse(packet, offset);

        const reports = [];
        let reportCount = decoded.reportCounter;

        offset = isSr ? 28 : 8;
        while (offset + 24 <= view.byteLength && reportCount--) {
            reports.push({
                synchronizationSource: view.getUint32(offset),
                fractionLost: Math.floor(view.getUint8(offset + 4) / 256.0 * 100),
                sequenceNumber: view.getUint32(offset + 8),
                jitter: view.getUint32(offset + 12),
                lsr: view.getUint32(offset + 16),
                dlsr: view.getUint32(offset + 20),
            });
            offset += 24;
        }

        if (decoded.reportCounter === reports.length) {
            return reports;
        }
        console.error('overflow in report block parsing');
    }
}
