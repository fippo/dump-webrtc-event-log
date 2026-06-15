// Difference between NTP epoch January 1st 1900 and Unix epoch
// January 1st 1970 in microseconds.
const NtpToEpochUs = 2208988800 * 1e+6;

function doImport(event) {
    event.target.disabled = true;

    const reader = new FileReader();
    reader.onload = ((file) => {
        return (e) => {
            const events = protoRootV2.lookupType('webrtc.rtclog2.EventStream').decode(new Uint8Array(e.target.result));
            if (events.stream.length > 0) { // legacy file format.
                // WebRTC-internals follows a certain format when creating the log file.
                // Try to interpret it as the timestamp of the capture, other
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
            decode(events);
            plot();
            savePCAP(file.name);
            const warning = document.createElement('div');
            warning.innerText = 'NOTE: new event log format detected.';
            document.body.appendChild(warning);
        };
    })(event.target.files[0]);
    reader.readAsArrayBuffer(event.target.files[0]);
}

// Load protbuf files at startup.
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
            resolve();
        });
    }),
]).then(() => {
    document.querySelector('input').disabled = false;
});

const options = {
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
        renderTo : 'container',
    },
    tooltip: {
        formatter: function(tooltip) {
            if (this.series.name === 'BWE probe clusters') {
                const packetInfos = this.point.packetInfos;
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
                return [
                    '<b>Delay based update</b>',
                    'Bitrate estimate: ' + this.point.y + 'bps',
                    'State: ' + {0: 'unknown', 1: 'normal', 2: 'underuse', 3: 'overuse'}[this.point.options.state || 0],
                ].join('<br>');
            } else if (this.series.name === 'Loss based updates') {
                return [
                    '<b>Loss based update</b>',
                    'Bitrate estimate: ' + this.point.y + 'bps',
                    'Fraction loss: ' + Math.round(this.point.options.fractionLoss / 255.0 * 100) + '%',
                ].join('<br>');
            } else if (['Outbound TWCC Loss Percentage > 0', 'Inbound TWCC Loss Percentage > 0'].includes(this.series.name)) {
                return [
                    'Loss percentage: ' + this.point.y + '%',
                    'Base sequence number: ' + this.point.baseSequenceNumber,
                ].join('<br>');
            }
            return tooltip.defaultFormatter.call(this, tooltip);
        },
        split: true,
    },
};
const searchParams = new URLSearchParams(window.location.search);
if (searchParams.has('export')) {
    // Different settings for webrtchacks posts optimized for small width.
    document.getElementById('container').style.width = 627;
    document.getElementById('container').style['min-width'] = 627;
    document.getElementById('container').style.height = 800;
    options.legend = {
        itemStyle: {
            fontSize: 9,
        },
    };
}
const graph = new Highcharts.Chart(options);

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
const rtxSsrcs = new Set();

function countRtp(relativeTimeMs, absoluteTimeMs, ssrc, incoming, headerLength, packetLength) {
    if (!perSsrcByteCount[ssrc]) {
        perSsrcByteCount[ssrc] = [0, relativeTimeMs];
        bitrateSeries[ssrc] = [[absoluteTimeMs, 0]];
        bitrateSeries[ssrc].incoming = incoming;
        // TODO: extract payload type to infer media type.
    }
    perSsrcByteCount[ssrc][0] += packetLength - headerLength;
    if (relativeTimeMs - perSsrcByteCount[ssrc][1] > 1000) {
        bitrateSeries[ssrc].push([absoluteTimeMs, 8000 * perSsrcByteCount[ssrc][0] / (relativeTimeMs - perSsrcByteCount[ssrc][1])]);
        perSsrcByteCount[ssrc] = [0, relativeTimeMs];
    }

    // Cumulated bitrate graphs.
    const direction = incoming ? 'total_incoming' : 'total_outgoing';
    if (!perSsrcByteCount[direction]) {
        perSsrcByteCount[direction] = [0, relativeTimeMs];
        bitrateSeries[direction] = [[absoluteTimeMs, 0]];
    }
    perSsrcByteCount[direction][0] += packetLength - headerLength;
    if (relativeTimeMs - perSsrcByteCount[direction][1] > 1000) {
        bitrateSeries[direction].push([absoluteTimeMs, 8000 * perSsrcByteCount[direction][0] / (relativeTimeMs - perSsrcByteCount[direction][1])]);
        perSsrcByteCount[direction] = [0, relativeTimeMs];
    }
}

function analyzeRtcp(packetData, incoming, absoluteTimeMs, absoluteTimeUs) {
    const direction = incoming ? 'inbound' : 'outbound';
    RTCP.forEach(packetData,
        {payloadType: RTCP.PT_PSFB, feedbackMessageType: RTCP.FMT_PLI, filter: (decoded) => {
            pictureLossIndications[direction].push({
                x: absoluteTimeMs,
                y: incoming ? 1 : 0, // TODO: maybe use one y value per ssrc?
                name: 'ssrc=' + decoded.synchronizationSource,
            });
        }},
        {payloadType: RTCP.PT_PSFB, feedbackMessageType: RTCP.FMT_ALFB, filter: (decoded, view) => {
            // https://datatracker.ietf.org/doc/html/draft-alvestrand-rmcat-remb-03#section-2
            if (view.getUint32(12) != 0x52454d42) {
                // REMB literal.
                return;
            }
            const exponent = view.getUint8(17) >> 2;
            const mantissa = view.getUint32(16) & 0x0003ffff;
            const remb = mantissa * Math.pow(2, exponent);
            rembValues[direction].push({
                x: absoluteTimeMs,
                y: remb,
                name: 'ssrc=' + decoded.synchronizationSource,
            });
        }},
        {payloadType: RTCP.PT_SR, filter: (decoded, view) => {
            // https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1
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
            if (incoming === false) {
                // Don't try parsing report blocks on outbound SRs.
                return;
            }
            const reports = RTCP.decodeReceiverReportBlocks(view, true);
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
            if (incoming === false && decoded.payloadType === RTCP.PT_RR) {
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
        {payloadType: RTCP.PT_RR, filter: (decoded, view) => {
            // https://www.rfc-editor.org/rfc/rfc3550#section-6.4.2
            const reports = RTCP.decodeReceiverReportBlocks(view, false);
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
            if (incoming === false && decoded.payloadType === RTCP.PT_RR) {
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
        {payloadType: RTCP.PT_RTPFB, feedbackMessageType: RTCP.FMT_ALFB, filter: (decoded, view) => {
            const result = RTCP.decodeTransportCC(view);
            if (!result) {
                return;
            }
            const lost = result.delta.reduce((count, delta) => delta === false ? count + 1 : count, 0);
            if (lost === 0) return;
            twccValues[direction].push({
                x: absoluteTimeMs,
                y: Math.floor(100 * lost / result.delta.length),
                baseSequenceNumber: result.baseSequenceNumber,
            });
        }},
    );
}

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
            countRtp(relativeTimeMs, absoluteTimeMs, ssrc, event.rtpPacket.incoming, event.rtpPacket.header.byteLength, event.rtpPacket.packetLength);
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
            analyzeRtcp(event.rtcpPacket.packetData, event.rtcpPacket.incoming, absoluteTimeMs, absoluteTimeUs);
            break;
        case 5: // audio playout event, ignore
            break;
        case 6: // loss based bwe update
            lossBasedUpdates.push({x: absoluteTimeMs, y: event.lossBasedBweUpdate.bitrateBps, fractionLoss: event.lossBasedBweUpdate.fractionLoss});
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
            }
            break;
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

function decodeDelta(deltas, base, numberOfDeltas) {
    return [base].concat((new FixedLengthDeltaDecoder(deltas, base, numberOfDeltas)).decode());
}

// Returns null if the field is not present in the proto message.
function decodeOptionalDelta(what, fieldName, deltasFieldName, numberOfDeltas) {
    if (!what.hasOwnProperty(fieldName) && (!what[deltasFieldName] || what[deltasFieldName].length === 0)) return null;
    const base = BigInt(what[fieldName] || 0);
    return [base].concat((new FixedLengthDeltaDecoder(what[deltasFieldName], base, numberOfDeltas)).decode());
}

function decodeRtpDelta(what) {
    const n = what.numberOfDeltas;
    const timestampMs = decodeDelta(what.timestampMsDeltas, BigInt(what.timestampMs), n);
    const ssrc = decodeDelta(what.ssrcDeltas, BigInt(what.ssrc), n);
    const padding = decodeDelta(what.paddingSizeDeltas, BigInt(what.paddingSize), n);
    const headerSize = decodeDelta(what.headerSizeDeltas, BigInt(what.headerSize), n);
    const marker = decodeDelta(what.markerDeltas, what.marker ? 1n : 0n, n);
    const payloadType = decodeDelta(what.payloadTypeDeltas, BigInt(what.payloadType), n);
    const sequenceNumber = decodeDelta(what.sequenceNumberDeltas, BigInt(what.sequenceNumber), n);
    const rtpTimestamp = decodeDelta(what.rtpTimestampDeltas, BigInt(what.rtpTimestamp), n);
    const payloadSize = decodeDelta(what.payloadSizeDeltas, BigInt(what.payloadSize), n);

    // Header extension values (optional — may not be present in every batch).
    // Use hasOwnProperty to distinguish "field absent" from "field is 0/false".
    const transportSequenceNumber = decodeOptionalDelta(what, 'transportSequenceNumber', 'transportSequenceNumberDeltas', n);
    const transmissionTimeOffset = decodeOptionalDelta(what, 'transmissionTimeOffset', 'transmissionTimeOffsetDeltas', n);
    const absoluteSendTime = decodeOptionalDelta(what, 'absoluteSendTime', 'absoluteSendTimeDeltas', n);
    const videoRotation = decodeOptionalDelta(what, 'videoRotation', 'videoRotationDeltas', n);
    const audioLevel = decodeOptionalDelta(what, 'audioLevel', 'audioLevelDeltas', n);
    const voiceActivity = decodeOptionalDelta(what, 'voiceActivity', 'voiceActivityDeltas', n);
    const probeClusterId = decodeOptionalDelta(what, 'probeClusterId', 'probeClusterIdDeltas', n);
    const rtxOriginalSequenceNumber = decodeOptionalDelta(what, 'rtxOriginalSequenceNumber', 'rtxOriginalSequenceNumberDeltas', n);

    const packets = new Array(timestampMs.length);
    for (let i = 0; i < timestampMs.length; i++) {
        packets[i] = {
            timestampMs: Number(timestampMs[i]),
            ssrc: Number(ssrc[i]),
            headerSize: Number(headerSize[i]),
            payloadSize: Number(payloadSize[i]),
            paddingSize: Number(padding[i]),
            sequenceNumber: Number(sequenceNumber[i]),
            rtpTimestamp: Number(rtpTimestamp[i]),
            payloadType: Number(payloadType[i]),
            marker: marker[i] !== 0n,
            hasPadding: padding[i] !== 0n,
            hasExtension: headerSize[i] > 12n,
        };
        // Attach header extension values if present.
        if (transportSequenceNumber) packets[i].transportSequenceNumber = Number(transportSequenceNumber[i]);
        if (transmissionTimeOffset) packets[i].transmissionTimeOffset = Number(transmissionTimeOffset[i]);
        if (absoluteSendTime) packets[i].absoluteSendTime = Number(absoluteSendTime[i]);
        if (videoRotation) packets[i].videoRotation = Number(videoRotation[i]);
        if (audioLevel) {
            packets[i].audioLevel = Number(audioLevel[i]);
            packets[i].voiceActivity = voiceActivity ? voiceActivity[i] !== 0n : false;
        }
        if (probeClusterId) packets[i].probeClusterId = Number(probeClusterId[i]);
        if (rtxOriginalSequenceNumber) packets[i].rtxOriginalSequenceNumber = Number(rtxOriginalSequenceNumber[i]);
    }
    return packets;
}

function decodeRtcpDelta(what) {
    const timestampMs = [what.timestampMs].concat((new FixedLengthDeltaDecoder(what.timestampMsDeltas, BigInt(what.timestampMs), what.numberOfDeltas)).decode());
    const packets = [what.rawPacket]
        .concat(what.rawPacketBlobs.length != 0 ? (new BlobDecoder(what.rawPacketBlobs, what.numberOfDeltas)).decode() : []);
    for (let i = 0; i < packets.length; i++) {
        packets[i].timestampMs = Number(timestampMs[i]);
    }
    return packets;
}

// Build a map from SSRC to RtpHeaderExtensionConfig from stream config events.
function buildExtensionIdMap(events) {
    const map = {}; // ssrc => {transportSequenceNumberId, absoluteSendTimeId, ...}
    const register = (ssrc, headerExtensions) => {
        if (!headerExtensions) return;
        map[ssrc] = {
            transportSequenceNumberId: headerExtensions.transportSequenceNumberId || 0,
            absoluteSendTimeId: headerExtensions.absoluteSendTimeId || 0,
            transmissionTimeOffsetId: headerExtensions.transmissionTimeOffsetId || 0,
            videoRotationId: headerExtensions.videoRotationId || 0,
            audioLevelId: headerExtensions.audioLevelId || 0,
        };
    };
    // Send configs: SSRC is the outgoing stream's own SSRC.
    (events.videoSendStreamConfigs || []).forEach(c => {
        register(c.ssrc, c.headerExtensions);
        if (c.rtxSsrc) register(c.rtxSsrc, c.headerExtensions);
    });
    (events.audioSendStreamConfigs || []).forEach(c => {
        register(c.ssrc, c.headerExtensions);
    });
    // Recv configs: remote_ssrc is the SSRC of the incoming RTP stream.
    (events.videoRecvStreamConfigs || []).forEach(c => {
        register(c.remoteSsrc, c.headerExtensions);
        if (c.rtxSsrc) register(c.rtxSsrc, c.headerExtensions);
    });
    (events.audioRecvStreamConfigs || []).forEach(c => {
        register(c.remoteSsrc, c.headerExtensions);
    });
    return map;
}

// Reconstruct an RTP packet (header + zero-filled payload + padding) from decoded metadata.
function reconstructRtpPacket(packet, extensionIdMap) {
    const config = extensionIdMap[packet.ssrc] || {};

    // Build the list of extensions to include.
    const extensions = [];
    if (config.transportSequenceNumberId && packet.transportSequenceNumber !== undefined) {
        extensions.push({id: config.transportSequenceNumberId, size: 2, write: (view, off) => view.setUint16(off, packet.transportSequenceNumber)});
    }
    if (config.absoluteSendTimeId && packet.absoluteSendTime !== undefined) {
        extensions.push({id: config.absoluteSendTimeId, size: 3, write: (view, off) => {
            view.setUint8(off, (packet.absoluteSendTime >> 16) & 0xff);
            view.setUint8(off + 1, (packet.absoluteSendTime >> 8) & 0xff);
            view.setUint8(off + 2, packet.absoluteSendTime & 0xff);
        }});
    }
    if (config.transmissionTimeOffsetId && packet.transmissionTimeOffset !== undefined) {
        extensions.push({id: config.transmissionTimeOffsetId, size: 3, write: (view, off) => {
            const val = packet.transmissionTimeOffset & 0xffffff;
            view.setUint8(off, (val >> 16) & 0xff);
            view.setUint8(off + 1, (val >> 8) & 0xff);
            view.setUint8(off + 2, val & 0xff);
        }});
    }
    if (config.videoRotationId && packet.videoRotation !== undefined) {
        extensions.push({id: config.videoRotationId, size: 1, write: (view, off) => view.setUint8(off, packet.videoRotation)});
    }
    if (config.audioLevelId && packet.audioLevel !== undefined) {
        // RFC 6464: V flag (1 bit) + level (7 bits)
        const byte = (packet.voiceActivity ? 0x80 : 0x00) | (packet.audioLevel & 0x7f);
        extensions.push({id: config.audioLevelId, size: 1, write: (view, off) => view.setUint8(off, byte)});
    }

    // Calculate extension block size.
    const hasExtensions = extensions.length > 0;
    let extensionDataBytes = 0;
    if (hasExtensions) {
        for (const ext of extensions) {
            extensionDataBytes += 1 + ext.size; // 1 byte header + data
        }
        // Pad to 4-byte boundary.
        extensionDataBytes = Math.ceil(extensionDataBytes / 4) * 4;
    }
    const extensionBlockSize = hasExtensions ? 4 + extensionDataBytes : 0; // 4 bytes for profile + length word

    const fixedHeaderSize = 12;
    const headerSize = fixedHeaderSize + extensionBlockSize;
    const totalSize = headerSize + packet.payloadSize + packet.paddingSize;
    const buf = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);

    // Fixed header: V=2, P, X, CC=0, M, PT, seq, timestamp, SSRC
    let byte0 = 0x80; // version 2
    if (packet.hasPadding && packet.paddingSize > 0) byte0 |= 0x20;
    if (hasExtensions) byte0 |= 0x10;
    view.setUint8(0, byte0);

    let byte1 = packet.payloadType & 0x7f;
    if (packet.marker) byte1 |= 0x80;
    view.setUint8(1, byte1);

    view.setUint16(2, packet.sequenceNumber & 0xffff);
    view.setUint32(4, packet.rtpTimestamp >>> 0);
    view.setUint32(8, packet.ssrc >>> 0);

    // One-byte header extension block (RFC 5285).
    if (hasExtensions) {
        view.setUint16(12, 0xBEDE); // one-byte header profile
        view.setUint16(14, extensionDataBytes / 4); // length in 32-bit words
        let offset = 16;
        for (const ext of extensions) {
            view.setUint8(offset, (ext.id << 4) | ((ext.size - 1) & 0x0f));
            offset++;
            ext.write(view, offset);
            offset += ext.size;
        }
        // Remaining bytes to the 4-byte boundary are already zero (padding).
    }

    // Payload is zero-filled (already zero from Uint8Array constructor).

    // Padding: last byte must equal the padding size per RFC 3550.
    if (packet.hasPadding && packet.paddingSize > 0) {
        buf[totalSize - 1] = packet.paddingSize;
    }

    return buf;
}

// Merge N sorted arrays by timestampMs using a simple k-way merge.
function mergeByTimestamp(...arrays) {
    const indices = arrays.map(() => 0);
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Array(totalLength);
    for (let r = 0; r < totalLength; r++) {
        let minIdx = -1;
        let minTs = Infinity;
        for (let k = 0; k < arrays.length; k++) {
            if (indices[k] < arrays[k].length && arrays[k][indices[k]].timestampMs < minTs) {
                minTs = arrays[k][indices[k]].timestampMs;
                minIdx = k;
            }
        }
        result[r] = arrays[minIdx][indices[minIdx]++];
    }
    return result;
}

function decodeLossBasedBweUpdate(what) {
    const timestampMs = [what.timestampMs].concat((new FixedLengthDeltaDecoder(what.timestampMsDeltas, BigInt(what.timestampMs), what.numberOfDeltas)).decode());
    const bitrateBps = [what.bitrateBps].concat((new FixedLengthDeltaDecoder(what.bitrateBpsDeltas, BigInt(what.bitrateBps), what.numberOfDeltas)).decode());
    const fractionLoss = [what.fractionLoss].concat((new FixedLengthDeltaDecoder(what.fractionLossDeltas, BigInt(what.fractionLoss), what.numberOfDeltas)).decode());
    return timestampMs.map((_, i) => ({
        timestampMs: Number(timestampMs[i]),
        bitrateBps: Number(bitrateBps[i]),
        fractionLoss: Number(fractionLoss[i]),
    }));
}

function decodeDelayBasedBweUpdate(what) {
    const timestampMs = [what.timestampMs].concat((new FixedLengthDeltaDecoder(what.timestampMsDeltas, BigInt(what.timestampMs), what.numberOfDeltas)).decode());
    const bitrateBps = [what.bitrateBps].concat((new FixedLengthDeltaDecoder(what.bitrateBpsDeltas, BigInt(what.bitrateBps), what.numberOfDeltas)).decode());
    const detectorState = [what.detectorState].concat((new FixedLengthDeltaDecoder(what.detectorStateDeltas, BigInt(what.detectorState), what.numberOfDeltas)).decode());
    return timestampMs.map((_, i) => ({
        timestampMs: Number(timestampMs[i]),
        bitrateBps: Number(bitrateBps[i]),
        detectorState: Number(detectorState[i]),
    }));
}

function decode(events) {
    let absoluteStartTimeMs;
    events.beginLogEvents.forEach(event => {
        absoluteStartTimeMs = event.utcTimeMs - event.timestampMs;
    });
    events.probeClusters.forEach(cluster => {
        bweProbeClusters.push({
            x: absoluteStartTimeMs + cluster.timestampMs,
            y: cluster.bitrateBps,
            name: cluster.id,
            bitrateBps: cluster.bitrateBps,
            minPackets: cluster.minPackets,
            minBytes: cluster.minBytes,
        });
    });
    events.probeSuccess.forEach(result => {
        const probeCluster = events.probeClusters.find(c => c.id === result.id);
        bweProbeResults.push({
            x: absoluteStartTimeMs + result.timestampMs,
            y: result.bitrateBps,
            name: result.id,
            delayMs: result.timestampMs - probeCluster.timestampMs,
        });
    });
    // TODO: probe failures.

    // Build RTX SSRC set from stream configs.
    (events.videoSendStreamConfigs || []).forEach(c => { if (c.rtxSsrc) rtxSsrcs.add(c.rtxSsrc); });
    (events.videoRecvStreamConfigs || []).forEach(c => { if (c.rtxSsrc) rtxSsrcs.add(c.rtxSsrc); });

    // Build SSRC => header extension ID mapping from stream configs.
    const extensionIdMap = buildExtensionIdMap(events);

    // Decode RTP packets.
    const outgoingRtpPackets = events.outgoingRtpPackets
        .map(decodeRtpDelta)
        .flat()
        .sort((a, b) => a.timestampMs - b.timestampMs);
    outgoingRtpPackets.forEach(packet => {
        packet.incoming = false; packet.type = 'rtp';
        if (!rtxSsrcs.has(packet.ssrc) && packet.rtxOriginalSequenceNumber !== undefined) rtxSsrcs.add(packet.ssrc);
    });
    window.outgoingRtpPackets = outgoingRtpPackets.slice();

    // Populate probe cluster to packet mapping from outgoing RTP packets.
    outgoingRtpPackets.forEach(packet => {
        if (packet.probeClusterId != null) {
            const cluster = packet.probeClusterId;
            if (!bweProbeClusterToPackets[cluster]) {
                bweProbeClusterToPackets[cluster] = [];
            }
            const twccSeqNum = packet.transportSequenceNumber;
            const packetLength = packet.headerSize + packet.payloadSize + packet.paddingSize;
            bweProbeClusterToPackets[cluster].push([twccSeqNum, packetLength]);
        }
    });

    const incomingRtpPackets = events.incomingRtpPackets
        .map(decodeRtpDelta)
        .flat()
        .sort((a, b) => a.timestampMs - b.timestampMs);
    incomingRtpPackets.forEach(packet => {
        packet.incoming = true; packet.type = 'rtp';
        if (!rtxSsrcs.has(packet.ssrc) && packet.rtxOriginalSequenceNumber !== undefined) rtxSsrcs.add(packet.ssrc);
    });

    // Decode RTCP packets.
    const outgoingRtcpPackets = events.outgoingRtcpPackets
        .map(decodeRtcpDelta)
        .flat()
        .sort((a, b) => a.timestampMs - b.timestampMs);
    outgoingRtcpPackets.forEach(packet => { packet.incoming = false; packet.type = 'rtcp'; });

    const incomingRtcpPackets = events.incomingRtcpPackets
        .map(decodeRtcpDelta)
        .flat()
        .sort((a, b) => a.timestampMs - b.timestampMs);
    incomingRtcpPackets.forEach(packet => { packet.incoming = true; packet.type = 'rtcp'; });

    // Unified merge of all RTP and RTCP packets in timestamp order, write to pcap.
    const allPackets = mergeByTimestamp(outgoingRtpPackets, incomingRtpPackets, outgoingRtcpPackets, incomingRtcpPackets);
    for (const packet of allPackets) {
        const absoluteTimeMs = absoluteStartTimeMs + packet.timestampMs;
        const timestampUs = absoluteTimeMs * 1000;
        if (packet.type === 'rtp') {
            const reconstructed = reconstructRtpPacket(packet, extensionIdMap);
            pcap.write(reconstructed, packet.incoming, reconstructed.byteLength, timestampUs);
            countRtp(packet.timestampMs, absoluteTimeMs, packet.ssrc, packet.incoming, packet.headerSize, packet.headerSize + packet.payloadSize + packet.paddingSize);
        } else {
            // RTCP: packet is a Uint8Array with timestampMs attached.
            pcap.write(packet, packet.incoming, packet.byteLength, timestampUs);
            analyzeRtcp(packet, packet.incoming, absoluteTimeMs, timestampUs);
        }
    }

    // Loss-based and delay-based BWE updates.
    events.lossBasedBweUpdates.forEach(update => {
        decodeLossBasedBweUpdate(update).forEach(result => {
            lossBasedUpdates.push({x: absoluteStartTimeMs + result.timestampMs, y: result.bitrateBps, fractionLoss: result.fractionLoss});
        });
    });
    events.delayBasedBweUpdates.forEach(update => {
        decodeDelayBasedBweUpdate(update).forEach(result => {
            delayBasedUpdates.push({x: absoluteStartTimeMs + result.timestampMs, y: result.bitrateBps, state: result.detectorState});
        });
    });
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
        },
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
    });

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
