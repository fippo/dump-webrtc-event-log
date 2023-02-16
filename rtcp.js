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
}
