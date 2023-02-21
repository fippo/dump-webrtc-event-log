# Dump chrome://webrtc-internals event log
Chrome 49 added a highly useful event log which, among other things, contains the RTP packet headers of any packets received or sent.
To capture it, expand the "Create Dump" section of chrome://webrtc-internals and click on the checkbox for "Enable diagnostic packet and event recording".
This will create protobuf files starting with the selected base filename
<i>&lt;base filename&gt;_&lt;date&gt;_&lt;timestamp&gt;_&lt;render process ID&gt;_&lt;recording ID&gt;</i>
These files can be imported using either the
<a href='https://source.chromium.org/chromium/chromium/src/+/main:third_party/webrtc/rtc_tools/rtc_event_log_visualizer/'>rtc_event_log_visualizer</a>
provided by libwebrtc or this tool.
The native libwebrtc event log visualizer is more feature-complete but requires a WebRTC build environment since it is a C++
program which generates a python script.
This tool lets you import the dumps using just a webpage that processes data locally.
It can generate a pcap of the RTP/RTCP packets for inspection in <a href="https://wireshark.org">Wireshark</a>.

## Source of the protobuf file
The proto file can be found in the webrtc source tree as either
```
logging/rtc_event_log/rtc_event_log2.proto
```
or `rtc_event_log.proto`.
