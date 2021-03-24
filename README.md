# Dump chrome://webrtc-internals event log
Chrome 49 added a highly useful event log which, among other things, contains the RTP packet headers of any packets received or sent.
See http://www.rtc.news/posts/aqZx7tevokRoSrSfw/how-to-get-a-webrtc-diagnostic-recording-from-chrome-49 for how to get it.

# Setup 
Install [Wireshark](https://www.wireshark.org/download.html) and [node.js](https://nodejs.org/en/download/) if not already installed.

To install the dependencies: `npm install`

# Usage
To dump all the packets:
```
node dump event_log_file
```

To dump all RTP traffic into a pcapng:
```
node rtp.js <file> | text2pcap -D -4 1.1.1.1,2.2.2.2 -u 10000,20000 -t "%T." -n - output/some.pcapng
```

To dump only incoming or outgoing RTP traffic into a pcapng, use either `incoming` or `outgoing` flag: 
```
node rtp.js <file> [incoming|outgoing] | text2pcap -D -4 1.1.1.1,2.2.2.2 -u 10000,20000 -t "%T." -n - output/some.pcapng
```


# Generating the protobuf file
rtc_event_log.proto is generated from the description in the webrtc.org tree:
```
protoc-c webrtc/logging/rtc_event_log/rtc_event_log.proto -o rtc_event_log.desc
```
