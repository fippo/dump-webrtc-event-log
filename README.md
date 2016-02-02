# Dump chrome://webrtc-internals event log
Chrome 49 added a highly useful event log which, among other things, contains the RTP packet headers of any packets received or sent.

# Usage
```
node dump event_log_file
```

To dump all incoming or outgoing RTP traffic into a PCAP:
```
node rtp.js event_log_file incoming | text2pcap -u 10000,20000 - some.pcap
node rtp.js event_log_file outgoing | text2pcap -u 10000,20000 - some.pcap
```
