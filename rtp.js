// RTP helper.
class RTP {
    /*
    * Apply a list of filters to the header extensions of a packet.
    * Each filter is an object specifying
    * * a id the filter applies to (may be undefined)
    * If the id is undefined or matches the decoded header extension id,
    * the filter method is called with
    * * the header extension id,
    * * a DataView for the content of the RTP header extension
    */
    static forEachExtension(packet, ...filters) {
        const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        if (view.byteLength < 12) {
            return false;
        }
        const first = view.getUint8(0);
        if (first >> 6 !== 2) {
            return false;
        }

        let headerLength = 12 + 4 * (first & 0x0f); // 12 + 4 * csrc count
        if (!first & 0x10) {
            return false;
        }
        // https://tools.ietf.org/html/rfc3550#section-5.3.1
        if (headerLength + 4 > view.byteLength) {
            return;
        }
        let offset = headerLength + 4;
        headerLength += 4 + 4 * view.getUint16(headerLength + 2);
        if (headerLength > view.byteLength) {
            return false;
        }
        const headerExtensionSize = headerLength;

        // Parse the header extensions.
        while (offset < headerExtensionSize) {
            if (offset + 1 > headerExtensionSize) {
                return false;
            }
            const extensionHeader = view.getUint8(offset);
            const extensionId = extensionHeader >> 4;
            const extensionLength = 1 + (extensionHeader & 0xf);
            if (extensionId === 0) {
                break;
            }
            if (offset + 1 + extensionLength > headerExtensionSize) {
                return false;
            }
            filters.forEach(({id, filter}) => {
                if (id === undefined || id === extensionId) {
                    filter(extensionId, new DataView(view.buffer, view.byteOffset + offset + 1, extensionLength));
                }
            });
            offset += 1 + extensionLength;
        }
    }
}