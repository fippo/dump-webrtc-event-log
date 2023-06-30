// Difference between NTP epoch January 1st 1900 and Unix epoch
// January 1st 1970 in microseconds.
const NtpToEpochUs = 2208988800 * 1e+6;

let file;
function doImport(event) {
    event.target.disabled = true;

    const reader = new FileReader();
    reader.onload = ((file) => {
        // WebRTC-internals follows a certain format when creating the log file.
        // Try to interpret it as the timestamp of the capture, other
        return (e) => {
            const events = protoRootV2.lookupType('webrtc.rtclog2.EventStream').decode(new Uint8Array(e.target.result));
            if (events.stream.length > 0) { // legacy file format.
                let absoluteStartTimeUs = 0;
                const dateMatch = event.target.files[0].name.match(/.*_(\d\d\d\d)(\d\d)(\d\d)_(\d\d)(\d\d)_(\d+)_.*.log/);
                if (dateMatch) {
                    absoluteStartTimeUs = new Date(dateMatch[1], parseInt(dateMatch[2], 10) - 1, dateMatch[3], dateMatch[4], dateMatch[5], dateMatch[6]).getTime() * 1000;
                }

                const legacy = protoRootV1.lookupType('webrtc.rtclog.EventStream').decode(new Uint8Array(e.target.result));
                legacy.stream.forEach((event) => decodeLegacy(event, legacy.stream[0].timestampUs, absoluteStartTimeUs));
                plot();
                savePCAP(file.name);
                return;
            }
            // TODO: interpret the new format.
            console.log('NEW FORMAT', events);
            // Start (stop) time is in events.beginLogEvents[0].utcTimeMs / endLogEvents (relative?)
            // ĐTLS events (connected)
            // ProbeClusters / ProbeSuccess / ProbeFailure
            // RemoteEstimates (REMB)
            // DecodeDeltas:
            // https://source.chromium.org/chromium/chromium/src/+/refs/heads/main:third_party/webrtc/logging/rtc_event_log/encoder/delta_encoding.cc;drc=a129ef22074b9f81f549ff068a15fc320072b3bb;l=807
            window.events = events;
        };
    })(event.target.files[0]);
    reader.readAsArrayBuffer(event.target.files[0]);
}

let protoRootV1;
let protoRootV2;
Promise.all([
    new Promise(resolve => {
        protobuf.load('rtc_event_log.proto', (err, root) => {
            if (err) {
                console.error(err);
                return;
            }
            protoRootV1 = root;
            resolve();
        });
    }),
    new Promise(resolve => {
        protobuf.load('rtc_event_log2.proto', (err, root) => {
            if (err) {
                console.error(err);
                return;
            }

            protoRootV2 = root;
        });
    }),
]).then(() => {
    document.querySelector('input').disabled = false;
});

const graph = new Highcharts.Chart({
    title: false,
    xAxis: {
        type: 'datetime',
    },
    yAxis: [{ // Bitrates.
        min: 0,
    }, { // Percentages.
        min: 0,
        max: 100,
        title: {
            text: '%',
        },
        labels: {
            format: '{value}%'
        },
        opposite: true,
    }, { // Round-trip time et al.
        min: 0,
        title: {
            text: 'seconds'
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
    tooltip: {
        formatter: function(tooltip) {
            if (this.series.name === 'BWE probe clusters') {
                const packetInfos = this.point.packetInfos;
                console.log(packetInfos, this.point);
                return [
                    '<b>Probe cluster ' + this.point.name + '</b>',
                    'Target bitrate: ' + this.point.y + 'bps',
                    'Sequence numbers: ' + (packetInfos ? packetInfos.map(i => i[0]).join(',') : '(not sent)'),
                    'Sizes: ' + (packetInfos ? packetInfos.map(i => i[1]).join(',') : '(not sent)'),
                ].join('<br>');
            } else if (this.series.name === 'BWE probe results') {
                return [
                    '<b>Probe result ' + this.point.name + '</b>',
                    'Delay: ' + this.point.delayMs + 'ms',
                    'Bandwidth estimate: ' + this.point.y + 'bps',
                ].join('<br>');
            } else if (this.series.name === 'Delay based updates') {
                console.log(this.point);
                return [
                    '<b>Delay based update</b>',
                    'Bitrate: ' + this.point.y + 'bps',
                    'State: ' + {0: 'normal', 1: 'overuse', 2: 'underuse'}[this.point.options.state || 0],
                ].join('<br>');
            }
            return tooltip.defaultFormatter.call(this, tooltip);
        },
        split: true,
    },

});

let basetime;
const bweProbeClusters = [];
const bweProbeResults = [];
const bweProbeClusterToPackets = { /* probe cluster id => [[twcc id, length]]*/};
const lossBasedUpdates = [];
const delayBasedUpdates = [];
const twccUri = 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01';
const twccId = {}; // per-ssrc mapping of configured TWCC header extension id for outbound.

const pictureLossIndications = {
    inbound: [],
    outbound: [],
};
const rembValues = {
    inbound: [],
    outbound: [],
};
const twccValues = {
    inbound: [],
    outbound: [],
};
const pictureLossIndicationsInbound = [];
const rtcpReceiverReport = {};
const rtcpSenderReport = {};
const rtcpRoundTripTime = {};
const pcap = new PCAPWriter();
const perSsrcByteCount = {};
const bitrateSeries = {};

function decodeLegacy(event, startTimeUs, absoluteStartTimeUs) {
    const relativeTimeMs = (event.timestampUs - startTimeUs) / 1000;
    const absoluteTimeMs = absoluteStartTimeUs / 1000 + relativeTimeMs;
    const absoluteTimeUs = absoluteStartTimeUs + (event.timestampUs - startTimeUs);
    switch(event.type) {
        case 3: //'RTP_EVENT':
            pcap.write(event.rtpPacket.header, event.rtpPacket.incoming, event.rtpPacket.packetLength, absoluteStartTimeUs + event.timestampUs - startTimeUs);
            // TODO: reuse the bitrate calculation code from rtcshark
            // Per-SSRC bitrate graphs.
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

            // Cumulated bitrate graphs.
            const direction = event.rtpPacket.incoming ? 'total_incoming' : 'total_outgoing'
            if (!perSsrcByteCount[direction]) {
                perSsrcByteCount[direction] = [0, relativeTimeMs];
                bitrateSeries[direction] = [[absoluteTimeMs, 0]];
            }
            perSsrcByteCount[direction][0] += event.rtpPacket.packetLength - event.rtpPacket.header.byteLength;
            if (relativeTimeMs - perSsrcByteCount[direction][1] > 1000) {
                bitrateSeries[direction].push([absoluteTimeMs, 8000 * perSsrcByteCount[direction][0] / (relativeTimeMs - perSsrcByteCount[direction][1])]);
                perSsrcByteCount[direction] = [0, relativeTimeMs];
            }
            // Populate probe cluster id => sequence number map
            if (!event.rtpPacket.incoming && event.rtpPacket.probeClusterId !== 0) {
                const cluster = event.rtpPacket.probeClusterId;
                if (!bweProbeClusterToPackets[cluster]) {
                    bweProbeClusterToPackets[cluster] = [];
                }
                RTP.forEachExtension(event.rtpPacket.header, {filter: (extensionId, data) => {
                    if (extensionId === twccId[ssrc]) {
                        bweProbeClusterToPackets[cluster].push([data.getUint16(0), event.rtpPacket.packetLength]);
                    }
                }});
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
                {payloadType: RTCP.PT_SR, filter: (decoded, packet, offset, length) => {
                    // https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1
                    const view = new DataView(packet.buffer, packet.byteOffset + offset, length);
                    if (!rtcpSenderReport[decoded.synchronizationSource]) {
                        rtcpSenderReport[decoded.synchronizationSource] = [];
                        // TODO: include direction?
                    }
                    const report = {
                        ntpTimestamp: view.getBigUint64(8),
                        ntpTimestampMiddleBits: view.getUint32(10),
                        rtpTimestamp: view.getUint32(12),
                        packetCount: view.getUint32(16),
                        octetCount: view.getUint32(20),
                        absoluteSendTimeUs: BigInt(absoluteTimeUs + NtpToEpochUs),
                    };

                    // Store so we can find it later.
                    rtcpSenderReport[decoded.synchronizationSource].push(report);

                    // Parse report blocks (uncommon in libWebRTC) to determine RTT.
                    if (event.rtcpPacket.incoming === false) {
                        // Don't try parsing report blocks on outbound SRs.
                        return;
                    }
                    const reports = RTCP.decodeReceiverReportBlocks(packet, offset, true);
                    reports.forEach(report => {
                        if (!rtcpReceiverReport[report.synchronizationSource]) {
                            rtcpReceiverReport[report.synchronizationSource] = [];
                            // TODO: include direction?
                        }
                        let name = 'ssrc=' + report.synchronizationSource;
                        rtcpReceiverReport[report.synchronizationSource].push({
                            x: absoluteTimeMs, // TODO: actually the time from the RR?
                            y: report.fractionLost,
                            name,
                        });
                    });
                    if (event.rtcpPacket.incoming === false && decoded.payloadType === RTCP.PT_RR) {
                        // Can not calculate RTT on outbound RR, this will always result in 0.
                        return;
                    }
                    reports.forEach(report => {
                        if (report.dlsr === 0) return;
                        // If DLSR is set, do RTT calculation as described in
                        // https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1
                        // alternatively: https://source.chromium.org/chromium/chromium/src/+/refs/heads/main:third_party/webrtc/modules/rtp_rtcp/source/rtcp_receiver.cc;l=609;drc=25f2ea1a864270fef1c96c014f552f1459280ac1;bpv=1;bpt=1
                        // But we have clock offset issues so we look at the local time we sent the SR.
                        if (!rtcpSenderReport[report.synchronizationSource]) {
                            // libWebRTC does not send SRs for RTX so there can be RRs without SRs)
                            return;
                        }
                        const associatedSenderReport = rtcpSenderReport[report.synchronizationSource]
                            .find(sr => sr.ntpTimestampMiddleBits === report.lsr);
                        if (associatedSenderReport) {
                            const rttAbsoluteUs = BigInt(absoluteTimeUs + NtpToEpochUs) - associatedSenderReport.absoluteSendTimeUs;
                            const dlsr = BigInt(Math.floor(report.dlsr / 65536 * 1e+6));
                            if (!rtcpRoundTripTime[report.synchronizationSource]) {
                                rtcpRoundTripTime[report.synchronizationSource] = [];
                            }
                            rtcpRoundTripTime[report.synchronizationSource].push({
                                x: absoluteTimeMs,
                                y: Number(rttAbsoluteUs - dlsr) / 1e+6,
                            });
                        }
                    });
                }},
                {payloadType: RTCP.PT_RR, filter: (decoded, packet, offset, length) => {
                    // https://www.rfc-editor.org/rfc/rfc3550#section-6.4.2
                    const reports = RTCP.decodeReceiverReportBlocks(packet, offset, false);
                    if (!reports) return;
                    reports.forEach(report => {
                        if (!rtcpReceiverReport[report.synchronizationSource]) {
                            rtcpReceiverReport[report.synchronizationSource] = [];
                            // TODO: include direction?
                        }
                        let name = 'ssrc=' + report.synchronizationSource;
                        rtcpReceiverReport[report.synchronizationSource].push({
                            x: absoluteTimeMs, // TODO: actually the time from the RR?
                            y: report.fractionLost,
                            name,
                        });
                    });
                    if (event.rtcpPacket.incoming === false && decoded.payloadType === RTCP.PT_RR) {
                        // Can not calculate RTT on outbound RR, this will always result in 0.
                        return;
                    }
                    reports.forEach(report => {
                        if (report.dlsr === 0) return;
                        // If DLSR is set, do RTT calculation as described in
                        // https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1
                        // alternatively: https://source.chromium.org/chromium/chromium/src/+/refs/heads/main:third_party/webrtc/modules/rtp_rtcp/source/rtcp_receiver.cc;l=609;drc=25f2ea1a864270fef1c96c014f552f1459280ac1;bpv=1;bpt=1
                        // But we have clock offset issues so we look at the local time we sent the SR.
                        if (!rtcpSenderReport[report.synchronizationSource]) {
                            // libWebRTC does not send SRs for RTX so there can be RRs without SRs)
                            return;
                        }
                        const associatedSenderReport = rtcpSenderReport[report.synchronizationSource]
                            .find(sr => sr.ntpTimestampMiddleBits === report.lsr);
                        if (associatedSenderReport) {
                            const rttAbsoluteUs = BigInt(absoluteTimeUs + NtpToEpochUs) - associatedSenderReport.absoluteSendTimeUs;
                            const dlsr = BigInt(Math.floor(report.dlsr / 65536 * 1e+6));
                            if (!rtcpRoundTripTime[report.synchronizationSource]) {
                                rtcpRoundTripTime[report.synchronizationSource] = [];
                            }
                            rtcpRoundTripTime[report.synchronizationSource].push({
                                x: absoluteTimeMs,
                                y: Number(rttAbsoluteUs - dlsr) / 1e+6,
                            });
                        }
                    });
                }},
                {payloadType: RTCP.PT_RTPFB, feedbackMessageType: RTCP.FMT_ALFB, filter: (decoded, packet, offset, length) => {
                    const direction = event.rtcpPacket.incoming ? 'inbound' : 'outbound';
                    const result = RTCP.decodeTransportCC(packet, offset);
                    if (!result) {
                        return;
                    }
                    const lost = result.delta.reduce((count, delta) => delta === false ? count + 1 : count, 0);
                    if (lost === 0) return;
                    twccValues[direction].push({
                        x: absoluteTimeMs,
                        y: Math.floor(100 * lost / result.delta.length),
                        name: 'baseSeq=' + result.baseSequenceNumber,
                    });
                }},
            );
            break;
        case 5: // audio playout event, ignore
            break;
        case 6: // loss based bwe update
            lossBasedUpdates.push([absoluteTimeMs, event.lossBasedBweUpdate.bitrateBps]);
            break;
        case 7: // delay based bwe update
            delayBasedUpdates.push({x: absoluteTimeMs, y: event.delayBasedBweUpdate.bitrateBps, state: event.delayBasedBweUpdate.detectorState});
            break;
        case 9: // Video send config
            event.videoSenderConfig.ssrcs.concat(event.videoSenderConfig.rtxSsrcs).forEach(ssrc => {
                const twccExt = event.videoSenderConfig.headerExtensions.find(ext => ext.name === twccUri);
                if (twccExt) {
                    twccId[ssrc] = twccExt.id;
                }
            });
            break;
        case 11: { // Audio send config
                const twccExt = event.audioSenderConfig.headerExtensions.find(ext => ext.name === twccUri);
                if (twccExt) {
                    twccId[event.audioSenderConfig.ssrc] = twccExt.id;
                }
                break;
            }
        case 17: // BweProbeCluster
            bweProbeClusters.push({
                x: absoluteTimeMs,
                y: event.probeCluster.bitrateBps,
                name: event.probeCluster.id,
            });
            break;
        case 18: // BweProbeResult
            const probeCluster = bweProbeClusters.find(c => c.name === event.probeResult.id);
            bweProbeResults.push({
                x: absoluteTimeMs,
                y: event.probeResult.bitrateBps,
                name: event.probeResult.id,
                delayMs: absoluteTimeMs - probeCluster.x,
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
    // Annotate BWE probe clusters with per-packet infos.
    bweProbeClusters.forEach(cluster => {
        cluster.packetInfos = bweProbeClusterToPackets[cluster.name];
    });
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
        {
            name: 'Outbound TWCC Loss Percentage > 0',
            type: 'scatter',
            data: twccValues['outbound'],
            yAxis: 1,
        },
        {
            name: 'Inbound TWCC Loss Percentage > 0',
            type: 'scatter',
            data: twccValues['inbound'],
            yAxis: 1,
        }
    ].map(series => {
        // Avoid hitting https://api.highcharts.com/highcharts/plotOptions.series.turboThreshold
        // for large scatter plots
        if (series.type === 'scatter' && series.data.length > 500) {
            console.log('Trimming `' + series.name + '`');
            delete series.type;
            series.data = series.data.map(point => [point.x, point.y]);
        }
        return series;
    }).forEach(series => graph.addSeries(series, false));
    Object.keys(bitrateSeries).forEach(ssrc => {
        graph.addSeries({
            name: 'average bitrate ssrc=' + ssrc + ' ' + (bitrateSeries[ssrc].incoming ? 'inbound' : 'outbound'),
            data: bitrateSeries[ssrc],
        }, false);
    });
    Object.keys(rtcpReceiverReport).forEach(ssrc => {
        graph.addSeries({
            name: 'RTCP RR loss percentage ssrc=' + ssrc,
            data: rtcpReceiverReport[ssrc],
            yAxis: 1,
        }, false);
    });
    Object.keys(rtcpRoundTripTime).forEach(ssrc => {
        graph.addSeries({
            name: 'RTCP RTT ssrc=' + ssrc,
            data: rtcpRoundTripTime[ssrc],
            yAxis: 2,
        }, false);
    })

    const toggle = document.getElementById('toggle');
    toggle.onchange = () => {
        graph.series.forEach(series => {
            series.setVisible(!toggle.checked, false);
        });
        graph.redraw();
    };
    toggle.disabled = false;
    graph.redraw();
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
