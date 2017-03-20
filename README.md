# Dump chrome://webrtc-internals event log
Chrome 49 added a highly useful event log which, among other things, contains the RTP packet headers of any packets received or sent.
See https://tokbox.com/blog/how-to-get-a-webrtc-diagnostic-recording-from-chrome-49/ for how to get it.

# Usage
```
node dump event_log_file
```

To dump all incoming or outgoing RTP traffic into a PCAP:
```
node rtp.js event_log_file incoming | text2pcap -t "%T." -u 10000,20000 - some.pcap
node rtp.js event_log_file outgoing | text2pcap -t "%T." -u 10000,20000 - some.pcap
```

# Generating the protobuf file
rtc_event_log.proto is generated from the description in the webrtc.org tree:
```
protoc-c webrtc/logging/rtc_event_log/rtc_event_log.proto -o rtc_event_log.proto
```
