var fs = require('fs');
var proto = require('protobufjs');
var p = proto.loadSync('rtc_event_log.proto');
var logfile = fs.readFileSync(process.argv[2]);

var EventStream = p.root.lookupType('webrtc.rtclog.EventStream');
var events = EventStream.decode(logfile);
console.log(JSON.stringify(events, null, ' '));
