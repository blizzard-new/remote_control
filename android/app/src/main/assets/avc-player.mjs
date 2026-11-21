// The HTTPS response is a sequence of big-endian length, timestamp (microseconds), flags and Annex B bytes.
export class PacketReader {
    constructor(reader) {
        this.reader = reader;
        this.pending = new Uint8Array();
    }

    async bytes(size, allowEnd = false) {
        const result = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            if (!this.pending.length) {
                const {value, done} = await this.reader.read();
                if (done && allowEnd && offset === 0) return null;
                if (done) throw new Error('連線在傳送畫格時中斷。');
                this.pending = value;
            }
            const count = Math.min(size - offset, this.pending.length);
            result.set(this.pending.subarray(0, count), offset);
            this.pending = this.pending.subarray(count);
            offset += count;
        }
        return result;
    }

    async next() {
        const header = await this.bytes(13, true);
        if (!header) return null;
        const view = new DataView(header.buffer);
        const size = view.getUint32(0);
        if (size < 1 || size > 4 * 1024 * 1024 || header[12] > 1) throw new Error('畫格格式無效。');
        return {
            key: header[12] === 1,
            timestamp: Number(view.getBigUint64(4)),
            data: await this.bytes(size),
        };
    }
}

export function avcCodec(data) {
    for (let i = 0; i + 6 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 7) {
            const profile = Array.from(data.subarray(i + 4, i + 7), n => n.toString(16).padStart(2, '0')).join('');
            return 'avc1.' + profile;
        }
    }
    throw new Error('關鍵畫格缺少 H.264 設定。請重新分享或改用相容模式。');
}

async function play() {
    const canvas = document.querySelector('canvas');
    const status = document.querySelector('p');
    const button = document.querySelector('button');
    const context = canvas.getContext('2d', {alpha: false});
    button.hidden = true;
    status.textContent = '正在連線…';
    const request = new AbortController();
    let failure = '';
    let decoder;
    const stop = () => request.abort();
    window.addEventListener('pagehide', stop, {once: true});
    try {
        if (!window.VideoDecoder) throw new Error('此瀏覽器無法使用 WebCodecs，請在手機重新選擇相容模式。');
        decoder = new VideoDecoder({
            output(frame) {
                try {
                    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                        canvas.width = frame.displayWidth;
                        canvas.height = frame.displayHeight;
                    }
                    context.drawImage(frame, 0, 0);
                } finally {
                    frame.close();
                }
            },
            error() {
                failure = '瀏覽器無法解碼這段 H.264 影像。請重新連線或在手機切換相容模式。';
                request.abort();
            },
        });
        const response = await fetch('/screen.avc', {signal: request.signal, cache: 'no-store'});
        if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream') {
            throw new Error('無法開啟串流。請確認手機仍在分享、觀看名額和配對碼。');
        }
        const stream = new PacketReader(response.body.getReader());
        let config, needKey = true;
        for (let frame; (frame = await stream.next());) {
            if (decoder.decodeQueueSize > 8) {
                decoder.reset();
                config = undefined;
                needKey = true;
            }
            if (!frame.key && needKey) continue;
            if (frame.key) {
                const codec = avcCodec(frame.data);
                if (codec !== config) {
                    if (config) decoder.reset();
                    const settings = {codec, optimizeForLatency: true};
                    if (!(await VideoDecoder.isConfigSupported(settings)).supported) {
                        throw new Error('此瀏覽器不支援這個 H.264 格式，請在手機改用相容模式。');
                    }
                    decoder.configure(settings);
                    config = codec;
                    status.textContent = '正在觀看 Android 螢幕 · H.264';
                }
                needKey = false;
            }
            decoder.decode(new EncodedVideoChunk({
                type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.data,
            }));
        }
        status.textContent = '分享已結束或連線已中斷。';
    } catch (error) {
        status.textContent = failure || error.message;
    } finally {
        window.removeEventListener('pagehide', stop);
        request.abort();
        if (decoder && decoder.state !== 'closed') decoder.close();
        button.hidden = false;
    }
}

if (typeof document !== 'undefined') {
    document.querySelector('button').addEventListener('click', play);
    play();
}
