
let localConnection;
let remoteConnection;
let sendChannel;
let receiveChannel;
let receiveBuffer = [];

let writer;
let files;

let inputFileProgress;
let inputFileOffsetProgress;
let inputTimeProgress;
let inputTimeStart;
let channelWriter;
let inputFileReader;
let inputFileOffset = 0;
let inputFileIndex = 0;
let zipEntries = [];
// Buffering file slice reads greatly improves performance
// and throughput.  The size of the buffer should take into
// account desired browser memory footprint and how much back-pressure
// we'll get downstream.
const INPUT_FILE_BUF_SIZE = 1024 * 1024 * 5;

async function createConnection() {
    localConnection = new RTCPeerConnection();
    console.log('Created local peer connection object localConnection');

    sendChannel = localConnection.createDataChannel('sendDataChannel');
    // chrome RTCDataChannels currently only support arraybuffer
    // transport
    sendChannel.binaryType = 'arraybuffer';

    console.log('Created send data channel');

    sendChannel.addEventListener('open', onSendChannelStateChange);
    sendChannel.addEventListener('close', onSendChannelStateChange);
    sendChannel.addEventListener('error', onError);
    channelWriter = new ChannelWriter(sendChannel);

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
}

async function onReceiveMessageCallback(event) {
    const a = event.data;
    if (a.byteLength > 0) {
        await writer.write(a);
    } else {
        console.log('END OF DATA');
        await writer.close();
        closeDataChannels();
    }
}

function closeDataChannels() {
    console.log('Closing data channels');
    sendChannel.close();
    console.log(`Closed data channel with label: ${sendChannel.label}`);
    sendChannel = null;
    channelWriter = null;
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
}

function onError(error) {
    if (sendChannel) {
        console.error('Error in sendChannel:', error);
        return;
    }
    console.log('Error in sendChannel which is already closed:', error);
}

async function onReceiveChannelStateChange(evt) {
    console.log("recv state change", evt);
    if (receiveChannel) {
        const readyState = receiveChannel.readyState;
        console.log(`Receive channel state is: ${readyState}`);
        if (readyState === 'open') {
            console.log('RECV CHAN STATE CHG open');
        }
    }
}

// this class represents the minimal info we need for a ZIP file entry
class Entry {
    // store the UTF-8 encoded bytes
    name;
    // size in bytes
    size;
    // offset in the ZIP data stream for the "Local File Header"
    lfhOffset = 0;
    constructor(file) {
        // NOTE, the 'webkitRelativePath' field contains the full path of a file
        // in a directory-based <input> file picker
        this.name = new TextEncoder('utf-8').encode(file.webkitRelativePath);
        this.size = BigInt(file.size);
    }
}

// this class is the primary interface for producing the ZIP output stream
// In this demo, we write the ZIP data to a WebRTC RTCDataChannel
class ChannelWriter {
    // the ZIP format requires back "references" to various offsets so we'll 
    // utilize a forward-only seek/offset value that tracks progress in the output
    offset = 0;
    channel;
    // we'll write at most this many bytes to the data channel as per RTC recommendations
    // there's probably a way to get this value dynamically from the channel negotation
    // process.
    chunkSize = 262144;

    constructor(dc, lowWaterMark = 262144, highWaterMark = 1048576) {
        this.channel = dc;
        this.paused = false;

        this.highWaterMark = highWaterMark;
        this.channel.bufferedAmountLowThreshold = lowWaterMark;
        // browser fires this message when:
        //  * the outbound browser buffer size _exceeds_ the low watermark
        //  * the outbound browser buffer empties enough to where it's _below_ the low watermark
        // 
        // thus, it won't fire when the size of the outbound browser buffer is >= 0 or < low watermark
        this.channel.onbufferedamountlow = () => {
            // resume once low watermark is crossed
            if (this.paused) {
                console.debug(`Data channel ${this.channel.label} resumed @ ${this.channel.bufferedAmount}`);
                this.paused = false;
                this.resolve();
            }
        };
    }


    // this is the base method for sending arraybuffer(s) to the channel where we handle
    // backpressure.
    async doSend(a) {
        if (this.paused) {
            throw new Error('oh fudge, already paused');
        }
        return new Promise((resolve) => {
            this.channel.send(a);
            if (!this.paused && this.channel.bufferedAmount < this.highWaterMark) {
                resolve();
            } else {
                // getting here means the buffered amount has accumulated over the highwatermark
                // so we'll pause further sends and let the browser tell us later when
                // the buffer shrinks back down to the low watermark
                console.debug('DC paused a=', a.byteLength, 'ba=', this.channel.bufferedAmount);
                this.paused = true;
                this.resolve = resolve;
            }
        });
    }

    // chunk a larger arraybuffer prior to submission
    async chunkArrayBuffer(a) {
        let off = 0;
        while (off < a.byteLength) {
            let len = Math.min(this.chunkSize, a.byteLength - off);
            let c = a.slice(off, off + len);
            await this.doSend(c);
            off += len;
        }
    }

    // primary method to send a single arraybuffer of arbitrary size
    async sendArrayBuffer(a) {
        if (a.byteLength > this.chunkSize) {
            await this.chunkArrayBuffer(a);
        } else {
            await this.doSend(a);
        }
        this.offset += a.byteLength;
    }

    // helper method to send either a single arraybuffer or an array of them
    async writeBuffer(b) {
        if (b instanceof Array) {
            for (let i = 0; i < b.length; i++) {
                await this.sendArrayBuffer(b[i]);
            }
        } else {
            await this.sendArrayBuffer(b);
        }
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




async function onFileReaderData(e) {
    inputFileOffset += e.target.result.byteLength;
    updateInputFileOffsetProgress();
    updateInputTimeProgress();
    await channelWriter.writeBuffer(e.target.result);


    if (inputFileOffset < files[inputFileIndex].size) {
        readSlice();
    } else {
        inputFileIndex += 1;
        updateInputFileProgress();
        if (inputFileIndex < files.length) {
            inputFileOffset = 0;
            await startFile();
            readSlice();
        } else {
            console.log('DONE READING ');
            updateInputTimeProgress();
            const eocdrStart = channelWriter.offset;
            for (let i = 0; i < zipEntries.length; i++) {
                const cDir = centralDir(zipEntries[i]);
                await channelWriter.writeBuffer(cDir);
            }
            const eocdrSize = channelWriter.offset - eocdrStart;
            const eocdr64Offset = channelWriter.offset;
            const eocdrHeader = eocd64(zipEntries.length, eocdrSize, eocdrStart);
            await channelWriter.writeBuffer(eocdrHeader);
            await channelWriter.writeBuffer(z64EOCDLocator(eocdr64Offset));
            await channelWriter.writeBuffer(eocd());
            await channelWriter.writeBuffer(new ArrayBuffer(0));
        }
    }
}

function readSlice() {
    const slice = files[inputFileIndex].slice(inputFileOffset, inputFileOffset + INPUT_FILE_BUF_SIZE);
    inputFileReader.readAsArrayBuffer(slice);
}

async function startFile() {
    const entry = new Entry(files[inputFileIndex]);
    const localHeader = lfhHeader(entry);
    zipEntries.push(entry);
    entry.lfhOffset = channelWriter.offset;
    await channelWriter.writeBuffer(localHeader);
}


function updateInputFileProgress() {
    inputFileProgress.innerHTML = `File ${inputFileIndex} of ${files.length}`;
}

function updateInputFileOffsetProgress() {
    inputFileOffsetProgress.innerHTML = `Byte ${inputFileOffset} of ${files[inputFileIndex].size}`;
}

function updateInputTimeProgress() {
    let n = performance.now();
    inputTimeProgress.innerHTML = `Time ${(n - inputTimeStart) / 1000} seconds`;
}


async function processFiles() {
    inputFileIndex = 0;
    updateInputFileProgress();
    inputFileOffset = 0;
    updateInputFileOffsetProgress();
    inputTimeStart = performance.now();
    updateInputTimeProgress();
    inputFileReader = new FileReader();
    inputFileReader.addEventListener('error', error => console.log('Error reading file:', error));
    inputFileReader.addEventListener('abort', event => console.log('File reading aborted:', event));
    inputFileReader.addEventListener('load', onFileReaderData);

    startFile();
    readSlice();
}

window.addEventListener('load',
    function () {
        var b = document.querySelector('#upload');
        inputFileProgress = document.querySelector('#inputFileProgress');
        inputFileOffsetProgress = document.querySelector("#inputFileOffsetProgress");
        const filesInput = document.getElementById('files');
        inputTimeProgress = document.querySelector('#inputTimeProgress');
        // all action starts from click of the "Upload" button
        b.addEventListener('click', async () => {
            files = [];
            // strip out those MacOS .DS_Store files from the selected files
            for (let i = 0; i < filesInput.files.length; i++) {
                let f = filesInput.files.item(i);
                if (f.name !== '.DS_Store') {
                    files.push(f);
                }
            }
            if (files.length === 0) {
                console.log('No files selected');
                return false;
            }

            // present a picker for the destination file
            const handle = await window.showSaveFilePicker();
            writer = await handle.createWritable();

            await createConnection();
            return false;
        });
        console.log("READY");
    });
