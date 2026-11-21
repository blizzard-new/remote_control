import assert from 'node:assert/strict';
import test from 'node:test';
import { PacketReader, avcCodec } from '../app/src/main/assets/avc-player.mjs';

function reader(chunks) {
    return new PacketReader(new ReadableStream({
        start(controller) {
            for (const bytes of chunks) controller.enqueue(new Uint8Array(bytes));
            controller.close();
        },
    }).getReader());
}

test('split headers, split payload and adjacent access units retain exact boundaries', async () => {
    const key = [0,0,0,1, 0x67,0x42,0x80,0x28];
    const delta = [0,0,1,0x41];
    const stream = reader([
        [0,0], [0,key.length, 0,0,0,0,0,0,0,30, 1, 0], key.slice(1, 3),
        [...key.slice(3), 0,0,0,delta.length, 0,0,0,0,0,0,0,60, 0, ...delta],
    ]);
    const first = await stream.next();
    assert.deepEqual(first, {key: true, timestamp: 30, data: Uint8Array.from(key)});
    assert.equal(avcCodec(first.data), 'avc1.428028');
    assert.deepEqual(await stream.next(), {key: false, timestamp: 60, data: Uint8Array.from(delta)});
    assert.equal(await stream.next(), null);
});

test('invalid size and truncated payload are rejected', async () => {
    await assert.rejects(reader([[255,255,255,255, 0,0,0,0,0,0,0,1, 0]]).next(), /格式/);
    await assert.rejects(reader([[0,0,0,3, 0,0,0,0,0,0,0,1, 1, 1,2]]).next(), /中斷/);
    assert.throws(() => avcCodec(new Uint8Array([0,0,1,0x68])), /H.264/);
});
