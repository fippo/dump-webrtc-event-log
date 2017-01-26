// extracts rtp packets and dumps then text2pcap format for easy import in wireshark.
// usage:
// node rtp.js <file> [incoming|outgoing] | text2pcap -u 10000,20000 - some.pcap
//
// rtc_event_log2rtp_dump probably does a better job but requires a webrtc build.
var fs = require('fs');
var proto = require('node-protobuf');
var p = new proto(fs.readFileSync('rtc_event_log.desc')); // compiled from https://chromium.googlesource.com/external/webrtc/+/master/webrtc/call/rtc_event_log.proto
var logfile = fs.readFileSync(process.argv[2]);

var incoming;
if (process.argv.length >= 3) {
  switch(process.argv[3]) {
  case 'incoming':
    incoming = true;
    break;
  case 'outgoing':
    incoming = false;
    break;
  default:
    console.log('unknown', process.argv[3]);
  }
}

function pad(num) {
    var s = '00000000' + num.toString(16);
    return s.substr(s.length - 8);
}

var events = p.parse(logfile, 'webrtc.rtclog.EventStream');
events.stream.forEach(function(event) {
    var packet;
    switch(event.type) {
    case 'RTP_EVENT':
        packet = event.rtp_packet;
        if (incoming !== undefined && incoming !== packet.incoming) return;

        // dump in rtpdump format.
        var hex = packet.header.toString('hex');
        var bytes = '';
        for (var j = 0; j < hex.length; j += 2) {
            bytes += hex[j] + hex[j+1] + ' ';
        }
        // add null payload
        for (j = 0; j < packet.packet_length; j++) {
            bytes += '00 ';
        }
        console.log(pad(0) + ' ' + bytes.trim());
        break;

    case 'RTCP_EVENT':
        packet = event.rtcp_packet;
        if (incoming !== undefined && incoming !== packet.incoming) return;
        var hex = packet.packet_data.toString('hex');
        var bytes = '';
        for (var j = 0; j < hex.length; j += 2) {
            bytes += hex[j] + hex[j+1] + ' ';
        }
        console.log(pad(0) + ' ' + bytes.trim());
        break;
    }
});
