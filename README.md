# Dump chrome://webrtc-internals event log
Chrome 49 added a highly useful event log which, among other things, contains the RTP packet headers of any packets received or sent.
See http://www.rtc.news/posts/aqZx7tevokRoSrSfw/how-to-get-a-webrtc-diagnostic-recording-from-chrome-49 for how to get it.

# Setup
Install [Wireshark](https://www.wireshark.org/download.html) and [node.js](https://nodejs.org/en/download/) if not already installed.

To install the dependencies: `npm install`

# Usage
The primary usage these days is done via the index.html web page which can visualize some graphs similar to the
webrtc native rtc_event_log_visualizer (which generates a python script that in turn generates matplotlib plots).

The website also allows downloading a PCAP containing the RAW RTP/RTCP packets sent and received.

## Source of the protobuf file
The proto file can be found in the webrtc source tree as either
```
logging/rtc_event_log/rtc_event_log2.proto
```
or `rtc_event_log.proto`.
