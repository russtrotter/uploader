
let localConnection;
let remoteConnection;
let sendChannel;
let receiveChannel;
let receiveBuffer = [];

// "offer from ... " negotation says max packet size is 262144 ?


async function createConnection() {
    localConnection = new RTCPeerConnection();
    console.log('Created local peer connection object localConnection');

    sendChannel = localConnection.createDataChannel('sendDataChannel');
    sendChannel.binaryType = 'arraybuffer';
    sendChannel.bufferedAmountLowThreshold = 1024 * 1024;
    console.log('Created send data channel');

    sendChannel.addEventListener('open', onSendChannelStateChange);
    sendChannel.addEventListener('close', onSendChannelStateChange);
    sendChannel.addEventListener('error', onError);
    sendChannel.addEventListener('bufferedamountlow', evt => {
        console.log("YO BRO BUF AMT LOW", evt);
    });

    localConnection.addEventListener('icecandidate', async event => {
        console.log('Local ICE candidate: ', event.candidate);
        await remoteConnection.addIceCandidate(event.candidate);
    });

    remoteConnection = new RTCPeerConnection();
    console.log('Created remote peer connection object remoteConnection');

    remoteConnection.addEventListener('icecandidate', async event => {
        console.log('Remote ICE candidate: ', event.candidate);
        await localConnection.addIceCandidate(event.candidate);
    });
    remoteConnection.addEventListener('datachannel', receiveChannelCallback);

    try {
        const offer = await localConnection.createOffer();
        await gotLocalDescription(offer);
    } catch (e) {
        console.log('Failed to create session description: ', e);
    }
}

async function onSendChannelStateChange() {
    if (sendChannel) {
        const { readyState } = sendChannel;
        console.log(`Send channel state is: ${readyState}`);
        if (readyState === 'open') {
            //sendData();
            //console.log('STUFF: sendData');
            await processFiles();
        }
    }
}

async function gotLocalDescription(desc) {
    await localConnection.setLocalDescription(desc);
    console.log(`Offer from localConnection\n ${desc.sdp}`);
    await remoteConnection.setRemoteDescription(desc);
    try {
        const answer = await remoteConnection.createAnswer();
        await gotRemoteDescription(answer);
    } catch (e) {
        console.log('Failed to create session description: ', e);
    }
}

async function gotRemoteDescription(desc) {
    await remoteConnection.setLocalDescription(desc);
    console.log(`Answer from remoteConnection\n ${desc.sdp}`);
    await localConnection.setRemoteDescription(desc);
}

function receiveChannelCallback(event) {
    console.log('Receive Channel Callback');
    receiveChannel = event.channel;
    receiveChannel.binaryType = 'arraybuffer';
    receiveChannel.onmessage = onReceiveMessageCallback;
    receiveChannel.onopen = onReceiveChannelStateChange;
    receiveChannel.onclose = onReceiveChannelStateChange;
    
    //receivedSize = 0;
    //bitrateMax = 0;
    //downloadAnchor.textContent = '';
    //downloadAnchor.removeAttribute('download');
    // if (downloadAnchor.href) {
    //   URL.revokeObjectURL(downloadAnchor.href);
    //   downloadAnchor.removeAttribute('href');
    // }
}

async function onReceiveMessageCallback(event) {
    //console.log(`FIXME Received Message ${event.data.byteLength}`);
    const a = event.data;
    if (a.byteLength > 0) {
        //console.log('DATA BLOCK ', a);
        await writer.write(a);
    } else {
        console.log('GOT EOD BUH BYE');
        await writer.close();
        closeDataChannels();
    }
    
    //console.log('RECV MSG', data.size);
    //receiveBuffer.push(event.data);
    //receivedSize += event.data.byteLength;

    // if (false) {
    //     closeDataChannels();
    // }
}

function closeDataChannels() {
    console.log('Closing data channels');
    sendChannel.close();
    console.log(`Closed data channel with label: ${sendChannel.label}`);
    sendChannel = null;
    if (receiveChannel) {
      receiveChannel.close();
      console.log(`Closed data channel with label: ${receiveChannel.label}`);
      receiveChannel = null;
    }
    localConnection.close();
    remoteConnection.close();
    localConnection = null;
    remoteConnection = null;
    console.log('Closed peer connections');
  
    // re-enable the file select
    //fileInput.disabled = false;
    //abortButton.disabled = true;
    //sendFileButton.disabled = false;
  }

// function onSendChannelStateChange() {
//     if (sendChannel) {
//         const { readyState } = sendChannel;
//         console.log(`Send channel state is: ${readyState}`);
//         if (readyState === 'open') {
//             sendData();
//         }
//     }
// }

function onError(error) {
    if (sendChannel) {
        console.error('Error in sendChannel:', error);
        return;
    }
    console.log('Error in sendChannel which is already closed:', error);
}

async function onReceiveChannelStateChange(evt) {
    console.log("BRUH recv state change", evt);
    if (receiveChannel) {
        const readyState = receiveChannel.readyState;
        console.log(`Receive channel state is: ${readyState}`);
        if (readyState === 'open') {
            //await displayStats();
            console.log('RECV CHAN STATE CHG open');
        }
    }
}

async function displayStats() {
    if (remoteConnection && remoteConnection.iceConnectionState === 'connected') {
        const stats = await remoteConnection.getStats();
        let activeCandidatePair;
        stats.forEach(report => {
            if (report.type === 'transport') {
                activeCandidatePair = stats.get(report.selectedCandidatePairId);
            }
        });
        if (activeCandidatePair) {
            if (timestampPrev === activeCandidatePair.timestamp) {
                return;
            }
            // calculate current bitrate
            const bytesNow = activeCandidatePair.bytesReceived;
            const bitrate = Math.round((bytesNow - bytesPrev) * 8 /
                (activeCandidatePair.timestamp - timestampPrev));
            bitrateDiv.innerHTML = `<strong>Current Bitrate:</strong> ${bitrate} kbits/sec`;
            timestampPrev = activeCandidatePair.timestamp;
            bytesPrev = bytesNow;
            if (bitrate > bitrateMax) {
                bitrateMax = bitrate;
            }
        }
    }
}

class Entry {
    name;
    size;
    lfhOffset = 0;
    constructor(file) {
        this.name = new TextEncoder('utf-8').encode(file.name);
        this.size = BigInt(file.size);
    }
}

class ChannelWriter {
    offset = 0;
    channel;
    chunkSize = 16384;

    constructor(channel) {
        this.channel = channel;
    }

    doSend(a) {
        this.channel.send(a);
    }

    chunkArrayBuffer(a) {
        let off = 0;
        while (off < a.byteLength) {
            let len = Math.min(this.chunkSize, a.byteLength - off);
            let c = a.slice(off, off + len);
            //console.log("CHUNK SEND ", c.byteLength);
            this.doSend(c);
            off += len;
        }
    }

    sendArrayBuffer(a) {
        if (a.byteLength > this.chunkSize) {
            this.chunkArrayBuffer(a);
        } else {
            //console.log("BLOCK SEND ", a.byteLength);
            this.doSend(a);
            
        }
        this.offset += a.byteLength;
    }

    writeBuffer(b) {
        if (b instanceof Array) {
            for (let i = 0; i < b.length; i++) {
                this.sendArrayBuffer(b[i]);
            }
        } else {
            this.sendArrayBuffer(b);
        }
    }
}

class DataWriter {
    writable;
    offset = 0;

    constructor(writable) {
        this.writable = writable;
    }

    async writeBlob(b) {
        console.log("PREBLOB", b.size, this.offset);
        await this.writable.write(b);
        this.offset += b.size;
        console.log("POSTBLOB", b.size, this.offset);
    }

    async writeBuffer(b) {
        console.log("PREBUF", b.byteLength, this.offset);
        await this.writable.write(b);
        this.offset += b.byteLength;
        console.log("POSTBUF", b.byteLength, this.offset);
    }

    async close() {
        await this.writable.close();
    }
}

function extraZip64(length, lfhOffset) {
    let sz = 16;
    let foo = 2 + 2 + sz;
    if (lfhOffset !== undefined) {
        foo += 8;
        sz += 8;
    }
    const buf = new ArrayBuffer(foo);
    const dv = new DataView(buf);
    dv.setUint16(0, 0x1, true);
    dv.setUint16(2, sz, true);
    dv.setBigUint64(4, BigInt(length), true);
    dv.setBigUint64(12, BigInt(length), true);
    if (lfhOffset !== undefined) {
        dv.setBigUint64(20, BigInt(lfhOffset), true);
    }
    return buf;
}

/*
0	4	Central directory file header signature = 0x02014b50
4	2	Version made by
6	2	Version needed to extract (minimum)
8	2	General purpose bit flag
10	2	Compression method
12	2	File last modification time
14	2	File last modification date
16	4	CRC-32 of uncompressed data
20	4	Compressed size (or 0xffffffff for ZIP64)
24	4	Uncompressed size (or 0xffffffff for ZIP64)
28	2	File name length (n)
30	2	Extra field length (m)
32	2	File comment length (k)
34	2	Disk number where file starts
36	2	Internal file attributes
38	4	External file attributes
42	4	Relative offset of local file header. This is the number of bytes between the start of the first disk on which the file occurs, and the start of the local file header. This allows software reading the central directory to locate the position of the file inside the ZIP file.
46	n	File name
46+n	m	Extra field
46+n+m	k	File comment
*/
function centralDir(entry) {
    const extraBuf = extraZip64(entry.size, entry.lfhOffset);
    const buf = new ArrayBuffer(46);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 8, true);
    dv.setUint32(12, 0, true);
    dv.setUint32(16, 0x0, true);
    dv.setUint32(20, 0xffffffff, true);
    dv.setUint32(24, 0xffffffff, true);
    dv.setUint16(28, entry.name.byteLength, true);
    dv.setUint16(30, extraBuf.byteLength, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, 0xffffffff, true);

    return [buf, entry.name, extraBuf];
}

/*
0	4	End of central directory signature = 0x06064b50
4	8	Size of the EOCD64 minus 12
12	2	Version made by
14	2	Version needed to extract (minimum)
16	4	Number of this disk
20	4	Disk where central directory starts
24	8	Number of central directory records on this disk
32	8	Total number of central directory records
40	8	Size of central directory (bytes)
48	8	Offset of start of central directory, relative to start of archive
56	n	Comment (up to the size of EOCD64)
*/
function eocd64(cdCount, cdSize, cdOffset) {
    const buf = new ArrayBuffer(56);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x06064b50, true);
    dv.setBigUint64(4, BigInt(buf.byteLength - 12), true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, 0, true);
    dv.setUint32(20, 0, true);
    dv.setBigUint64(24, BigInt(cdCount), true);
    dv.setBigUint64(32, BigInt(cdCount), true);
    dv.setBigUint64(40, BigInt(cdSize), true);
    dv.setBigUint64(48, BigInt(cdOffset), true);
    return buf;
}

function z64EOCDLocator(eocdOffset) {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x07064b50, true);
    dv.setUint32(4, 0, true);
    dv.setBigUint64(8, BigInt(eocdOffset), true);
    dv.setUint32(16, 1, true);
    return buf;
}

/*
0	4	End of central directory signature = 0x06054b50
4	2	Number of this disk (or 0xffff for ZIP64)
6	2	Disk where central directory starts (or 0xffff for ZIP64)
8	2	Number of central directory records on this disk (or 0xffff for ZIP64)
10	2	Total number of central directory records (or 0xffff for ZIP64)
12	4	Size of central directory (bytes) (or 0xffffffff for ZIP64)
16	4	Offset of start of central directory, relative to start of archive (or 0xffffffff for ZIP64)
20	2	Comment length (n)
22	n	Comment
*/
function eocd() {
    const buf = new ArrayBuffer(22);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0xffff, true);
    dv.setUint16(6, 0xffff, true);
    dv.setUint16(8, 0xffff, true);
    dv.setUint16(10, 0xffff, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, 0xffffffff, true);
    dv.setUint16(20, 0, true);
    return buf;
}

/*
   0	4	Local file header signature = 0x04034b50 (PK♥♦ or "PK\3\4")
   4	2	Version needed to extract (minimum)
   6	2	General purpose bit flag
   8	2	Compression method; e.g. none = 0, DEFLATE = 8 (or "\0x08\0x00")
   10	2	File last modification time
   12	2	File last modification date
   14	4	CRC-32 of uncompressed data
   18	4	Compressed size (or 0xffffffff for ZIP64)
   22	4	Uncompressed size (or 0xffffffff for ZIP64)
   26	2	File name length (n)
   28	2	Extra field length (m)
   30	n	File name
   30+n	m	Extra field
*/
function lfhHeader(entry) {
    const buf = new ArrayBuffer(30);
    const dataView = new DataView(buf);
    const extraBuf = extraZip64(entry.size);

    dataView.setUint32(0, 0x4034b50, true);
    dataView.setUint16(4, 20, true);
    dataView.setUint16(6, 0x8, true);
    dataView.setUint16(8, 0, true);
    dataView.setUint32(10, 0, true);
    dataView.setUint32(14, 0x0, true);
    dataView.setUint32(18, 0xffffffff, true);
    dataView.setUint32(22, 0xffffffff, true);
    dataView.setUint16(26, entry.name.byteLength, true);
    dataView.setUint16(28, extraBuf.byteLength, true);
    return [buf, entry.name, extraBuf];
}

let writer;
let files;

async function processFiles() {
    //const dw = new DataWriter(writer);
    const dw = new ChannelWriter(sendChannel);
    let entries = [];
    const chunkSize = 1024 * 1024 * 5;
    const start = performance.now();

    let fileReader = new FileReader();
    let fileIndex = 0;

    let offset = 0;
    fileReader.addEventListener('error', error => console.log('Error reading file:', error));
    fileReader.addEventListener('abort', event => console.log('File reading aborted:', event));
    fileReader.addEventListener('load', async e => {
        //sendChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        console.log('SENDCH BUF AMT ', sendChannel.bufferedAmount);
        dw.writeBuffer(e.target.result);

        //sendProgress.value = offset;
        if (offset < files[fileIndex].size) {
            readSlice(offset);
        } else {
            fileIndex += 1;
            if (fileIndex < files.length) {
                offset = 0;
                startFile();
                readSlice(offset);
            } else {
                console.log('DONE READING ', (performance.now() - start) / 1000);

                const eocdrStart = dw.offset;
                for (let i = 0; i < entries.length; i++) {
                    const cDir = centralDir(entries[i]);
                    dw.writeBuffer(cDir);
                }
                const eocdrSize = dw.offset - eocdrStart;
                const eocdr64Offset = dw.offset;
                const eocdrHeader = eocd64(entries.length, eocdrSize, eocdrStart);
                dw.writeBuffer(eocdrHeader);
                dw.writeBuffer(z64EOCDLocator(eocdr64Offset));
                dw.writeBuffer(eocd());
                //dw.close();
                //await writer.close();
                dw.writeBuffer(new ArrayBuffer(0));
            }
        }
    });
    const readSlice = o => {
        const slice = files[fileIndex].slice(offset, o + chunkSize);
        fileReader.readAsArrayBuffer(slice);
    };
    const startFile = async () => {
        const entry = new Entry(files[fileIndex]);
        const localHeader = lfhHeader(entry);
        entries.push(entry);
        entry.lfhOffset = dw.offset;
        dw.writeBuffer(localHeader);
    };
    startFile();
    readSlice(0);
}

window.addEventListener('load',
    function () {
        var b = document.querySelector('#upload');
        const filesInput = document.querySelector('#files');
        b.addEventListener('click', async () => {
            files = filesInput.files;
            if (files.length === 0) {
                console.log('No files selected');
                return false;
            }
            
            const handle = await window.showSaveFilePicker();
            writer = await handle.createWritable();
            
            await createConnection();
            return false;
        });
        console.log("READY");
    });
