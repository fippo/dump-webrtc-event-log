const headerLength = 42;
function makeHeader(inbound, dataLength) {
    const header = new Uint8Array([
        // Ethernet
        0x0a, 0x02, 0x02, 0x02, 0x02, 0x01, 0x0a, 0x02, 0x02, 0x02, 0x02, 0x02, 0x08, 0x00,
        // IP
        0x45, 0x00,
        0x00, 0x00, // length
        0x12, 0x34, 0x00, 0x00, 0xff, 0x11, 0x92, 0x54,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Address, depends on inbound/outbound
        // UDP
        0x00, 0x00, 0x00, 0x00, // source port and destination port
        0x00, 0x00, // length
        0x00, 0x00, // checksum
    ]);
    if (inbound) {
        header.set([0x0a, 0x02, 0x02, 0x02, 0x0a, 0x01, 0x01, 0x01], 26); // 10.2.2.2 -> 10.1.1.1
    } else {
        header.set([0x0a, 0x01, 0x01, 0x01, 0x0a, 0x02, 0x02, 0x02], 26); // 10.1.1.1 -> 10.2.2.2
    }
    const view = new DataView(header.buffer);
    view.setUint16(16, dataLength + 8 + 20);
    view.setUint16(38, dataLength + 8);
    // set UDP ports.
    view.setUint16(34, inbound ? 1000 : 2000);
    view.setUint16(36, inbound ? 2000 : 1000);
    return header;
}

class PCAPWriter {
    constructor() {
        this.buffers = [
            new Uint8Array(24),
        ];
        const header = new DataView(this.buffers[0].buffer);
        header.setUint32(0, 0xa1b2c3d4);
        header.setUint16(4, 2);
        header.setUint16(6, 4);
        header.setInt32(8, 0); // pretend we're GMT.
        header.setUint32(12, 0);
        header.setUint32(16, 256 * 1024);
        header.setUint32(20, 1); // Ethernet.
    }

    write(packet, inbound, originalLength, timestamp) {
        this.buffers.push(new Uint8Array(16));
        // https://wiki.wireshark.org/Development/LibpcapFileFormat#record-packet-header
        const header = new DataView(this.buffers[this.buffers.length - 1].buffer);
        header.setUint32(0, timestamp / 1000);
        header.setUint32(4, timestamp % 1000);
        header.setUint32(8, packet.length + headerLength);
        header.setUint32(12, originalLength + headerLength);
        const fullPacket = new Uint8Array(headerLength + packet.byteLength);
        fullPacket.set(makeHeader(inbound, originalLength), 0);
        fullPacket.set(packet, headerLength);
        this.buffers.push(fullPacket);
    }
    save() {
        return new Blob(this.buffers, {type: 'application/vnd.tcpdump.pcap'});
    }
}