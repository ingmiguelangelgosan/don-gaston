import { setup } from '../interop/jarvis-real-harness.mjs';

const writer = await setup({
  maintenance: true,
  transformReply() {
    const { maintenance, paths, actor, sendStarts, receivedRequests } = writer;
    process.send({
      path: maintenance.path,
      epoch: maintenance.epoch,
      paths,
      actor,
      sendStarts,
      receivedRequests,
      phase: writer.state(request).phase,
    });
    // The adapter has committed and returned. Keep the response and the
    // enclosing Gateway/dispatch operations pending until the parent kills us.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    throw new Error('Expected the parent to interrupt the synthetic writer');
  },
});

const request = writer.record();
try {
  await writer.execute(request);
} finally {
  await writer.close();
}
