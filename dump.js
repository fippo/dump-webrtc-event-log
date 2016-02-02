var fs = require('fs');
var proto = require('node-protobuf');
var p = new proto(fs.readFileSync('rtc_event_log.desc')); // compiled from https://chromium.googlesource.com/external/webrtc/+/master/webrtc/call/rtc_event_log.proto
var logfile = fs.readFileSync(process.argv[2]);

var events = p.parse(logfile, 'webrtc.rtclog.EventStream');
console.log(JSON.stringify(events, null, ' '));
