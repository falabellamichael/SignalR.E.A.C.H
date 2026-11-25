import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AccountStore } from '../service/store.mjs';
import { createModelGateway } from '../service/model-gateway.mjs';

const videoModel = {
  id: 'minimax-h3-video',
  name: 'MiniMax H3 Video (Hermes)',
  provider: 'Hermes',
  metered: true,
  access: 'requests',
  bridge: { kind: 'gpu', model: 'comfy/minimax-h3-r2v' },
};
const imageModel = {
  id: 'flux-schnell-image',
  name: 'FLUX.1 Schnell Image (Hermes)',
  provider: 'Hermes',
  metered: true,
  access: 'requests',
  bridge: { kind: 'gpu', model: 'comfy/flux-schnell' },
};
const models = [videoModel];
const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
  overageUsdMicrosPerRequest: 10000, proEnabled: false };
const wallet = '0x' + '44'.repeat(20);
const request = (extra = {}) => ({ model: videoModel.id, prompt: 'A cat flies over the ocean.', ...extra });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

function comfyMock({ failPrompt = false, failHistory = false, pending = 0, image = false } = {}) {
  const calls = [];
  let historyHits = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const path = new URL(url).pathname + new URL(url).search;
    if (path === '/upload/image') {
      return new Response(JSON.stringify({ name: 'reach_key1.png', subfolder: '', type: 'input' }),
        { headers: { 'content-type': 'application/json' } });
    }
    if (path === '/prompt') {
      if (failPrompt) return new Response(JSON.stringify({ error: 'bad node' }), { status: 400 });
      return new Response(JSON.stringify({ prompt_id: 'pid-1111-2222-3333', number: 1, node_errors: {} }),
        { headers: { 'content-type': 'application/json' } });
    }
    if (path.startsWith('/history/')) {
      if (failHistory) throw new Error('ComfyUI down');
      historyHits += 1;
      if (historyHits <= pending) return new Response('{}', { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        'pid-1111-2222-3333': {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { save: image
            ? { images: [{ filename: 'img_00001_.png', subfolder: 'reach', type: 'output' }] }
            : { videos: [{ filename: 'gen_00001_.mp4', subfolder: 'reach', type: 'output' }] } },
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (path.startsWith('/view?')) {
      return new Response('FAKE-MP4-BYTES', { headers: { 'content-type': 'video/mp4' } });
    }
    throw new Error(`unexpected comfy call ${url}`);
  };
  return { fetchImpl, calls };
}

async function fixture(t, fetchImpl, { paid = true, models: configuredModels = models } = {}) {
  const store = new AccountStore(':memory:', { models: configuredModels, subscription });
  t.after(() => store.close());
  const account = store.ensureAccount(wallet);
  if (paid) store.grantPlan({ wallet, grantId: 'comfy-test-period', planId: 'basic-wallet', name: 'Basic',
    models: configuredModels.map(model => model.id), tokens: 0, expiresAt: Date.now() + 3600000 });
  const gateway = createModelGateway({ store, models: configuredModels, subscription, fetchImpl });
  const server = createServer((req, res) => gateway.handle(req, res, store.account(account.id)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, account, gateway, base,
    call: (body = request(), key = 'comfy-request', path = '/v1/video/generations') => fetch(
      `${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body) }),
    media: path => fetch(`${base}${path}`) };
}

test('comfy video model advertises the video generation endpoint', async t => {
  const { fetchImpl } = comfyMock();
  const f = await fixture(t, fetchImpl);
  const catalog = f.gateway.catalog(f.store.account(f.account.id)).data;
  const entry = catalog.find(model => model.id === 'minimax-h3-video');
  assert.ok(entry);
  assert.equal(entry.capabilities.video, true);
  assert.equal(entry.capabilities.endpoint, '/v1/video/generations');
});

test('video generation submits the minimax workflow, polls history, and returns media URLs', async t => {
  const { fetchImpl, calls } = comfyMock();
  const f = await fixture(t, fetchImpl);
  const response = await f.call();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'video.generation');
  assert.equal(body.model, 'minimax-h3-video');
  assert.equal(body.id, 'pid-1111-2222-3333');
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].filename, 'gen_00001_.mp4');
  assert.equal(body.data[0].url, '/v1/media/pid-1111-2222-3333/gen_00001_.mp4');
  const promptCall = calls.find(call => new URL(call.url).pathname === '/prompt');
  const submitted = JSON.parse(promptCall.options.body);
  const nodes = Object.values(submitted.prompt);
  assert.equal(nodes.find(node => node.class_type === 'MiniMaxH3ReferenceToVideo').inputs.prompt,
    'A cat flies over the ocean.');
  const loader = nodes.find(node => node.class_type === 'UnetLoaderGGUF');
  assert.equal(loader.inputs.unet_name, 'MiniMax-H3-Ref2VA-Pruned-Q4_K_M.gguf');
  assert.equal(submitted.client_id, 'comfy-request');
});

test('identical idempotent request replays without redispatch', async t => {
  const { fetchImpl, calls } = comfyMock();
  const f = await fixture(t, fetchImpl);
  const first = await f.call(request(), 'same-key');
  assert.equal(first.status, 200);
  const second = await f.call(request(), 'same-key');
  assert.equal(second.status, 200);
  assert.equal(await second.text(), await first.text());
  assert.equal(calls.filter(call => new URL(call.url).pathname === '/prompt').length, 1);
});

test('reference images are uploaded and wired into the workflow', async t => {
  const { fetchImpl, calls } = comfyMock();
  const f = await fixture(t, fetchImpl);
  const response = await f.call(request({ reference_image: `data:image/png;base64,${PNG}` }));
  assert.equal(response.status, 200);
  const upload = calls.find(call => new URL(call.url).pathname === '/upload/image');
  assert.ok(upload);
  const submitted = JSON.parse(calls.find(call => new URL(call.url).pathname === '/prompt').options.body);
  const nodes = Object.values(submitted.prompt);
  const ref = nodes.find(node => node.class_type === 'MiniMaxH3ReferenceToVideo');
  assert.equal(ref.inputs['ref_images.ref_image_0'][0], 'img');
  assert.equal(nodes.find(node => node.class_type === 'LoadImage').inputs.image, 'reach_key1.png');
});

test('generation requests reject bad input before any dispatch', async t => {
  const { fetchImpl, calls } = comfyMock();
  const f = await fixture(t, fetchImpl);
  for (const [body, status] of [
    [{ model: videoModel.id }, 400],
    [request({ prompt: '' }), 400],
    [request({ prompt: 'x', unknown: 1 }), 400],
    [request({ duration_seconds: 0 }), 400],
    [request({ duration_seconds: 16 }), 400],
    [request({ width: 300 }), 400],
    [request({ steps: 41 }), 400],
    [request({ seed: -1 }), 400],
    [request({ reference_image: 'data:image/gif;base64,AAAA' }), 400],
    [request({ reference_image: 'not-a-data-url' }), 400],
  ]) {
    assert.equal((await f.call(body, 'bad-' + JSON.stringify(body).length + Math.random())).status, status);
  }
  assert.equal((await f.call(request({ model: 'not-a-model' }))).status, 404);
  assert.equal(calls.length, 0);
});

test('video model rejects the chat endpoint and vice versa', async t => {
  const { fetchImpl, calls } = comfyMock();
  const f = await fixture(t, fetchImpl);
  const response = await f.call({ model: videoModel.id, messages: [{ role: 'user', content: 'hi' }] },
    'wrong-endpoint', '/v1/chat/completions');
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('comfy backend failure releases the reservation so the same key can retry', async t => {
  const { fetchImpl } = comfyMock({ failPrompt: true });
  const f = await fixture(t, fetchImpl);
  const first = await f.call(request(), 'flaky');
  assert.equal(first.status, 502);
  assert.equal((await first.json()).error.code, 'comfy_error');
  const recovered = comfyMock();
  // Rebuild the gateway with a working backend against the same store.
  const gateway2 = createModelGateway({ store: f.store, models, subscription, fetchImpl: recovered.fetchImpl });
  const server2 = createServer((req, res) => gateway2.handle(req, res, f.store.account(f.account.id)));
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  t.after(async () => { server2.closeAllConnections(); await new Promise(resolve => server2.close(resolve)); });
  const retry = await fetch(`http://127.0.0.1:${server2.address().port}/v1/video/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'flaky' },
    body: JSON.stringify(request()) });
  assert.equal(retry.status, 200);
});

test('media route streams backend output for files the generation produced', async t => {
  const { fetchImpl } = comfyMock();
  const f = await fixture(t, fetchImpl);
  const response = await f.call();
  assert.equal(response.status, 200);
  const { data } = await response.json();
  const media = await f.media(data[0].url);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.equal(await media.text(), 'FAKE-MP4-BYTES');
});

test('image generation submits the flux workflow and returns image media URLs', async t => {
  const { fetchImpl, calls } = comfyMock({ image: true });
  const f = await fixture(t, fetchImpl, { models: [imageModel] });
  const response = await f.call({ model: imageModel.id, prompt: 'A fox in a wheat field.', seed: 7 },
    'image-request', '/v1/images/generations');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'image.generation');
  assert.equal(body.model, 'flux-schnell-image');
  assert.equal(body.data[0].filename, 'img_00001_.png');
  assert.equal(body.data[0].url, '/v1/media/pid-1111-2222-3333/img_00001_.png');
  const submitted = JSON.parse(calls.find(call => new URL(call.url).pathname === '/prompt').options.body);
  const nodes = Object.values(submitted.prompt);
  assert.equal(nodes.find(node => node.class_type === 'UnetLoaderGGUF').inputs.unet_name,
    'flux1-schnell-Q4_K_S.gguf');
  const enc = nodes.find(node => node.class_type === 'CLIPTextEncodeFlux');
  assert.equal(enc.inputs.t5xxl, 'A fox in a wheat field.');
  assert.equal(nodes.find(node => node.class_type === 'KSampler').inputs.seed, 7);
  assert.ok(nodes.find(node => node.class_type === 'SaveImage'));
});

test('image endpoint rejects video-only fields and cross-endpoint mismatches', async t => {
  const { fetchImpl, calls } = comfyMock({ image: true });
  const f = await fixture(t, fetchImpl, { models: [imageModel, videoModel] });
  for (const extra of [{ duration_seconds: 5 }, { turbo: false },
    { reference_image: `data:image/png;base64,${PNG}` }]) {
    const response = await f.call({ model: imageModel.id, prompt: 'x', ...extra },
      `image-bad-${Math.random()}`, '/v1/images/generations');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unsupported_field');
  }
  const wrongOp = await f.call({ model: imageModel.id, prompt: 'x' },
    'image-on-video', '/v1/video/generations');
  assert.equal(wrongOp.status, 400);
  const wrongOp2 = await f.call({ model: videoModel.id, prompt: 'x' },
    'video-on-image', '/v1/images/generations');
  assert.equal(wrongOp2.status, 400);
  assert.equal(calls.length, 0);
});

test('media route rejects files outside the generation record', async t => {
  const { fetchImpl } = comfyMock();
  const f = await fixture(t, fetchImpl);
  await f.call();
  assert.equal((await f.media('/v1/media/pid-1111-2222-3333/gen_00002_.mp4')).status, 404);
  assert.equal((await f.media('/v1/media/other-prompt-id/gen_00001_.mp4')).status, 404);
  assert.equal((await f.media('/v1/media/pid-1111-2222-3333/..%2f..%2fsecret')).status, 404);
});
