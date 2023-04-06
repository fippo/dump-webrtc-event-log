
let file;
function doImport(event) {
    event.target.disabled = true;
    const stream = protoRoot.lookupType('webrtc.rtclog.EventStream');

    let absoluteStartTimeUs = 0;
    const dateMatch = event.target.files[0].name.match(/.*_(\d\d\d\d)(\d\d)(\d\d)_(\d\d)(\d\d)_(\d+)_.*.log/);
    if (dateMatch) {
        absoluteStartTimeUs = new Date(dateMatch[1], dateMatch[2], dateMatch[3], dateMatch[4], dateMatch[5], dateMatch[6]).getTime() * 1000;
    }

    const reader = new FileReader();
    reader.onload = ((file) => {
        // WebRTC-internals follows a certain format when creating the log file.
        // Try to interpret it as the timestamp of the capture, other
        return (e) => {
            const events = stream.decode(new Uint8Array(e.target.result));
            events.stream.forEach((event) => decode(event, events.stream[0].timestampUs, absoluteStartTimeUs));
            plot();
            savePCAP(file.name);
        };
    })(event.target.files[0]);
    reader.readAsArrayBuffer(event.target.files[0]);
}

let protoRoot;
const p = protobuf.load('rtc_event_log.proto', (err, root) => {
    if (err) {
        console.error(err);
        return;
    }
    document.querySelector('input').disabled = false;
    protoRoot = root;
});

const graph = new Highcharts.Chart({
    title: false,
    xAxis: {
        type: 'datetime',
    },
    yAxis: [{
        min: 0,
    }, {
        min: 0,
        max: 100,
        title: {
            text: '%',
        },
        labels: {
            format: '{value}%'
        },
        opposite: true,
    }],
    plotOptions: {
        scatter: {
            dataLabels: {
                format: '{point.name}',
                enabled: true
            },
        }
    },
    chart: {
        zoomType: 'x',
        renderTo : 'graph',
    },
});

let basetime;
const bweProbeClusters = [];
const bweProbeResults = [];
const lossBasedUpdates = [];
const delayBasedUpdates = [];
const pictureLossIndications = {
    inbound: [],
    outbound: [],
};
const rembValues = {
    inbound: [],
    outbound: [],
};
const pictureLossIndicationsInbound = [];
const rtcpReceiverReport = {};
const pcap = new PCAPWriter();
const perSsrcByteCount = {};
const bitrateSeries = {};

function decode(event, startTimeUs, absoluteStartTimeUs) {
    const relativeTimeMs = (event.timestampUs - startTimeUs) / 1000;
    const absoluteTimeMs = absoluteStartTimeUs / 1000 + relativeTimeMs;
    switch(event.type) {
        case 3: //'RTP_EVENT':
            pcap.write(event.rtpPacket.header, event.rtpPacket.incoming, event.rtpPacket.packetLength, absoluteStartTimeUs + event.timestampUs - startTimeUs);
            // TODO: reuse the bitrate calculation code from rtcshark
            const ssrc = new DataView(event.rtpPacket.header.buffer, event.rtpPacket.header.byteOffset, event.rtpPacket.header.byteLength).getUint32(8);
            if (!perSsrcByteCount[ssrc]) {
                perSsrcByteCount[ssrc] = [0, relativeTimeMs];
                bitrateSeries[ssrc] = [[absoluteTimeMs, 0]];
                bitrateSeries[ssrc].incoming = event.rtpPacket.incoming;
                // TODO: extract payload type to infer media type.
            }
            perSsrcByteCount[ssrc][0] += event.rtpPacket.packetLength - event.rtpPacket.header.byteLength;
            if (relativeTimeMs - perSsrcByteCount[ssrc][1] > 1000) {
                bitrateSeries[ssrc].push([absoluteTimeMs, 8000 * perSsrcByteCount[ssrc][0] / (relativeTimeMs - perSsrcByteCount[ssrc][1])]);
                perSsrcByteCount[ssrc] = [0, relativeTimeMs];
            }
            break;
        case 4: //'RTCP_EVENT':
            pcap.write(event.rtcpPacket.packetData, event.rtcpPacket.incoming, event.rtcpPacket.packetData.byteLength, absoluteStartTimeUs + event.timestampUs - startTimeUs);
            RTCP.forEach(event.rtcpPacket.packetData,
                {payloadType: RTCP.PT_PFB, feedbackMessageType: RTCP.FMT_PLI, filter: (decoded) => {
                    pictureLossIndications[event.rtcpPacket.incoming ? 'inbound' : 'outbound'].push({
                        x: absoluteTimeMs,
                        y: event.rtcpPacket.incoming ? 1 : 0, // TODO: maybe use one y value per ssrc?
                        name: 'ssrc=' + decoded.synchronizationSource,
                    });
                }},
                {payloadType: RTCP.PT_PSFB, feedbackMessageType: RTCP.FMT_ALFB, filter: (decoded, packet, offset, length) => {
                    // https://datatracker.ietf.org/doc/html/draft-alvestrand-rmcat-remb-03#section-2
                    const view = new DataView(packet.buffer, packet.byteOffset + offset, length);
                    if (view.getUint32(12) != 0x52454d42) {
                        // REMB literal.
                        return;
                    }
                    const exponent = view.getUint8(17) >> 2;
                    const mantissa = view.getUint32(16) & 0x0003ffff;
                    const remb = mantissa * Math.pow(2, exponent);
                    rembValues[event.rtcpPacket.incoming ? 'inbound' : 'outbound'].push({
                        x: absoluteTimeMs,
                        y: remb,
                        name: 'ssrc=' + decoded.synchronizationSource,
                    });
                }},
                {payloadType: RTCP.PT_RR, filter: (decoded, packet, offset, length) => {
                    const view = new DataView(packet.buffer, packet.byteOffset + offset, length)
                    const reports = [];

                    offset = 8;
                    while (offset + 24 <= view.byteLength) {
                        reports.push({
                            synchronizationSource: view.getUint32(offset),
                            fractionLost: Math.floor(view.getUint8(offset + 4) / 256.0 * 100),
                        });
                        offset += 24;
                    }
                    if (decoded.reportCounter === reports.length) {
                        reports.forEach(report => {
                            if (!rtcpReceiverReport[report.synchronizationSource]) {
                                rtcpReceiverReport[report.synchronizationSource] = [];
                                // TODO: include direction?
                            }
                            rtcpReceiverReport[report.synchronizationSource].push({
                                x: absoluteTimeMs, // TODO: actually the time from the RR?
                                y: report.fractionLost,
                                name: 'ssrc=' + report.synchronizationSource,
                            })
                        });
                    }
                }},
            );
            break;
        case 5: // audio playout event, ignore
            break;
        case 6: // loss based bwe update
            lossBasedUpdates.push([absoluteTimeMs, event.lossBasedBweUpdate.bitrateBps]);
            break;
        case 7: // delay based bwe update
            delayBasedUpdates.push([absoluteTimeMs, event.delayBasedBweUpdate.bitrateBps]);
            break;
        case 17: // BweProbeCluster
            bweProbeClusters.push({
                x: absoluteTimeMs,
                y: event.probeCluster.bitrateBps,
                name: event.probeCluster.id,
            });
            break;
        case 18: // BweProbeResult
            bweProbeResults.push({
                x: absoluteTimeMs,
                y: event.probeResult.bitrateBps,
                name: event.probeResult.id,
            });
            break;
        case 19: // AlrState
            break;
        default:
            //console.log(event.type, event);
            break;
    }
}

function plot() {
    [
        {
            name: 'BWE probe clusters',
            type: 'scatter',
            data: bweProbeClusters,
        },
        {
            name: 'BWE probe results',
            type: 'scatter',
            data: bweProbeResults,
        },
        {
            name: 'Loss based updates',
            data: lossBasedUpdates,
            step: 'left',
            dashStyle: 'Dash',
        },
        {
            name: 'Delay based updates',
            data: delayBasedUpdates,
            step: 'left',
            dashStyle: 'Dash',
        },
        {
            name: 'Inbound REMB',
            type: 'scatter',
            data: rembValues['inbound'],
        },
        {
            name: 'Outbound REMB',
            type: 'scatter',
            data: rembValues['outbound'],
        },
        {
            name: 'Inbound RTCP PLI (picture loss indication)',
            type: 'scatter',
            data: pictureLossIndications['inbound'],
        },
        {
            name: 'Outbound RTCP PLI (picture loss indication)',
            type: 'scatter',
            data: pictureLossIndications['outbound'],
        },
    ].forEach(series => graph.addSeries(series));
    Object.keys(bitrateSeries).forEach(ssrc => {
        graph.addSeries({
            name: 'average bitrate ssrc=' + ssrc + ' ' + (bitrateSeries[ssrc].incoming ? 'inbound' : 'outbound'),
            data: bitrateSeries[ssrc],
        });
    });
    Object.keys(rtcpReceiverReport).forEach(ssrc => {
        graph.addSeries({
            name: 'RTCP RR loss percentage ssrc=' + ssrc,
            data: rtcpReceiverReport[ssrc],
            yAxis: 1,
        });
    });
    const toggle = document.getElementById('toggle');
    toggle.onchange = () => {
        graph.series.forEach(series => {
            series.setVisible(!toggle.checked, false);
        });
        graph.redraw();
    };
    toggle.disabled = false;
}

function savePCAP(filename) {
    const blob = pcap.save();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '.pcap';
    a.innerText = 'Download PCAP';
    document.getElementById('download').appendChild(a);
}