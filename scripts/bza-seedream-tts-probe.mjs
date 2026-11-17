/**
 * Direct wire probe for bza Coding Plan Seedream (image) + Seed TTS (audio).
 * Same packet shapes as src/backends/ark.ts. Credential is read in-process
 * from the active DSH credential store and NEVER printed or logged.
 *
 * Usage: node scripts/bza-seedream-tts-probe.mjs
 * Writes: synthmedia-output/bza-seedream-real/*, synthmedia-output/bza-seed-tts-real/*
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import yaml from '/Users/mars/.dsh/profiles/web/node_modules/js-yaml/index.js';

const BASE = 'https://llm.inner.bza.edu.cn/plan/v3';
const CRED_FILE = '/Users/mars/.dsh/.credentials-cli.yaml';

const doc = yaml.load(readFileSync(CRED_FILE, 'utf8'));
const KEY = doc?.refs?.SYNTHMEDIA_BZA_API_KEY;
if (typeof KEY !== 'string' || KEY.length === 0) throw new Error('SYNTHMEDIA_BZA_API_KEY not found in active credential store');

const outImg = 'synthmedia-output/bza-seedream-real';
const outTts = 'synthmedia-output/bza-seed-tts-real';
mkdirSync(outImg, { recursive: true });
mkdirSync(outTts, { recursive: true });

const sanitizeUrl = (u) => (typeof u === 'string' ? u.replace(/^https?:\/\/[^/?]+/, (m) => m).slice(0, 160) : u);

async function timed(fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e), elapsedMs: Date.now() - t0 };
  }
}

// ---------- 1. Seedream image ----------
const imgJobs = [];
async function imageCall(model) {
  const body = { model, prompt: '一张白纸折成的纸船漂在浅水洼里，晨光逆光，浅景深，写实电影感', response_format: 'url', watermark: false };
  const rec = { model, request: body, timestamp: new Date().toISOString() };
  const r = await timed(async () => {
    const res = await fetch(`${BASE}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    rec.httpStatus = res.status;
    rec.responseRaw = text.slice(0, 4000);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`non-json http ${res.status}: ${text.slice(0, 200)}`); }
    if (res.status !== 200) throw new Error(`http ${res.status}: ${(data.error?.message ?? text).slice(0, 300)}`);
    const first = data.data?.[0];
    if (!first) throw new Error(`no data[0]: ${text.slice(0, 300)}`);
    rec.usage = data.usage ?? null;
    if (first.url) {
      const dl = await fetch(first.url);
      if (dl.status !== 200) throw new Error(`image download failed http ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const mime = (dl.headers.get('content-type') ?? '').split(';')[0];
      const file = `${outImg}/image-${model}.png`;
      writeFileSync(file, buf);
      rec.artifact = { path: file, bytes: buf.length, mimeType: mime, urlTruncated: sanitizeUrl(first.url) };
    } else if (first.b64_json) {
      const buf = Buffer.from(first.b64_json, 'base64');
      const file = `${outImg}/image-${model}.png`;
      writeFileSync(file, buf);
      rec.artifact = { path: file, bytes: buf.length, mimeType: first.output_format === 'png' ? 'image/png' : 'image/jpeg', source: 'b64_json' };
    } else {
      throw new Error(`neither url nor b64_json: ${JSON.stringify(first).slice(0, 300)}`);
    }
    return 'ok';
  });
  rec.outcome = r.error ? `FAILED: ${r.error}` : 'ok';
  rec.elapsedMs = r.elapsedMs;
  return rec;
}

imgJobs.push(await imageCall('doubao-seedream-5.0-pro'));
if (imgJobs[0].outcome !== 'ok') {
  console.log('pro failed, falling back to flash:', imgJobs[0].outcome);
  imgJobs.push(await imageCall('doubao-seedream-5.0-flash'));
}

// ---------- 2. Seed TTS ----------
const ttsText = '一只纸船漂在水面上，安静地向前行驶';
const uniqueId = randomUUID();
const ttsHeaders = {
  'Content-Type': 'application/json',
  'X-Api-Key': KEY,
  'X-Api-Resource-Id': 'seed-tts-2.0',
  'X-Api-Request-Id': randomUUID(),
};
const ttsSubmitBody = {
  user: { uid: 'synthmedia' },
  unique_id: uniqueId,
  req_params: {
    text: ttsText,
    speaker: 'zh_female_xiaohe_uranus_bigtts',
    audio_params: { format: 'mp3', sample_rate: 24000 },
  },
};
const ttsRecord = { timestamp: new Date().toISOString(), request: JSON.parse(JSON.stringify(ttsSubmitBody)) };
delete ttsRecord.request.unique_id; // keep it simple; taskId tracked below
ttsRecord.requestId = uniqueId;

const sub = await timed(async () => {
  const res = await fetch(`${BASE}/api/v3/tts/submit`, { method: 'POST', headers: ttsHeaders, body: JSON.stringify(ttsSubmitBody) });
  const text = await res.text();
  ttsRecord.submitHttpStatus = res.status;
  ttsRecord.submitResponseRaw = text.slice(0, 2000);
  const data = JSON.parse(text);
  if (typeof data.code === 'number' && data.code !== 20000000) throw new Error(`tts rejected (code ${data.code}): ${data.message}`);
  if (res.status !== 200) throw new Error(`tts http ${res.status}: ${text.slice(0, 300)}`);
  const taskId = data.data?.task_id ?? data.data?.id ?? uniqueId;
  if (!taskId) throw new Error('no task id in submit response');
  return taskId;
});
ttsRecord.elapsedSubmitMs = sub.elapsedMs;
let taskId = sub.error ? null : sub;

if (taskId) {
  ttsRecord.taskId = taskId;
  ttsRecord.polls = [];
  let audioUrl = null;
  for (let i = 0; i < 60 && !audioUrl; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pr = await timed(async () => {
      const res = await fetch(`${BASE}/api/v3/tts/query`, {
        method: 'POST',
        headers: { ...ttsHeaders, 'X-Api-Request-Id': randomUUID() },
        body: JSON.stringify({ task_id: taskId }),
      });
      const text = await res.text();
      const data = JSON.parse(text);
      const pollRec = { timestamp: new Date().toISOString(), httpStatus: res.status, code: data.code, taskStatus: data.data?.task_status, message: data.message ?? null };
      ttsRecord.polls.push(pollRec);
      if (typeof data.code === 'number' && data.code !== 20000000) throw new Error(`query rejected (code ${data.code}): ${data.message}`);
      if (data.data?.audio_url) return data.data.audio_url;
      if (data.data?.task_status === 3) throw new Error('tts task failed');
      return null;
    });
    if (pr.error) { ttsRecord.outcome = `FAILED at poll: ${pr.error}`; break; }
    audioUrl = pr;
  }
  if (audioUrl) {
    const dl = await timed(async () => {
      const res = await fetch(audioUrl);
      if (res.status !== 200) throw new Error(`audio download failed http ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const file = `${outTts}/speech.mp3`;
      writeFileSync(file, buf);
      ttsRecord.artifact = { path: file, bytes: buf.length, mimeType: (res.headers.get('content-type') ?? 'audio/mpeg').split(';')[0], urlTruncated: sanitizeUrl(audioUrl) };
      ttsRecord.outcome = 'ok';
      return 'ok';
    });
    if (dl.error) ttsRecord.outcome = `FAILED at download: ${dl.error}`;
  } else if (!ttsRecord.outcome) {
    ttsRecord.outcome = 'FAILED: polling exhausted without audio_url';
  }
} else {
  ttsRecord.outcome = `FAILED at submit: ${sub.error}`;
}
ttsRecord.totalElapsedMs = undefined; // not needed; per-stage timings kept

writeFileSync(`${outImg}/job.json`, JSON.stringify({ backend: 'bza-seedream', gateway: BASE.replace('https://', '') , calls: imgJobs }, null, 2));
writeFileSync(`${outTts}/job.json`, JSON.stringify({ backend: 'bza-seed-tts', gateway: BASE.replace('https://', ''), ...ttsRecord }, null, 2));
console.log('IMAGE:', imgJobs.map((j) => `${j.model} -> ${j.outcome} (${j.elapsedMs}ms)`).join('; '));
console.log('TTS:', ttsRecord.outcome, 'taskId=', ttsRecord.taskId ?? '(none)', 'submitMs=', ttsRecord.elapsedSubmitMs, 'polls=', (ttsRecord.polls ?? []).length);
console.log('artifact:', imgJobs.find((j) => j.artifact)?.artifact, ttsRecord.artifact);
