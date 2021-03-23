// extracts rtp packets and dumps then text2pcap format for easy import in wireshark.
// usage:
// node rtp.js <file> [incoming|outgoing] | text2pcap -u 10000,20000 - some.pcap
//
// rtc_event_log2rtp_dump probably does a better job but requires a webrtc build.
var fs = require('fs');
var proto = require('protobufjs');
var p = proto.loadSync('rtc_event_log.proto'); // compiled from https://chromium.googlesource.com/external/webrtc/+/master/webrtc/call/rtc_event_log.proto
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

function strftime(time) {
    var time_h = Math.floor(time / 3.6e9);
    time -= time_h * 3.6e9;
    var time_m = Math.floor(time / 6e7);
    time -= time_m * 6e7;
    var time_s = Math.floor(time / 1e6);
    time -= time_s * 1e6;
    return time_h.toString() + ':' + time_m.toString() + ':' + time_s.toString()
        + '.' + ('000000' + time).substr(-6);
}

var basetime;
var EventStream = p.root.lookupType('webrtc.rtclog.EventStream');
var events = EventStream.decode(logfile);
events.stream.forEach(function(event) {

    // Use first packet in any direction as base time
    switch(event.type) {
    case 3://'RTP_EVENT':
    case 4://'RTCP_EVENT':
        if (basetime === undefined)
            basetime = event.timestampUs;
        break;
    }
        

    var packet;
    switch(event.type) {
    case 3://'RTP_EVENT':
        packet = event.rtpPacket;
        if (incoming !== undefined && incoming !== packet.incoming) return;

        console.log(strftime(event.timestampUs - basetime));

        // dump in rtpdump format.
        var hex = packet.header.toString('hex');
        var bytes = '';
        for (var j = 0; j < hex.length; j += 2) {
            bytes += hex[j] + hex[j+1] + ' ';
        }
        // add null payload
        for (j = 0; j < packet.packetLength; j++) {
            bytes += '00 ';
        }
        console.log(pad(0) + ' ' + bytes.trim());
        break;

    case 4://'RTCP_EVENT':
        packet = event.rtcpPacket;
        if (incoming !== undefined && incoming !== packet.incoming) return;

        console.log(strftime(event.timestampUs - basetime));

        var hex = packet.packetData.toString('hex');
        var bytes = '';
        for (var j = 0; j < hex.length; j += 2) {
            bytes += hex[j] + hex[j+1] + ' ';
        }
        console.log(pad(0) + ' ' + bytes.trim());
        break;
    }
});
