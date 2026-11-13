/**
 * Duplicate-submission guard for the zgci hub validation script.
 *
 * The ledger is the primary durable record, but it can be missing or stale
 * (deleted checkout, a run started before the ledger existed, a crashed
 * writer). A second real create must still be impossible, so this module ALSO
 * scans the output root for evidence of an earlier submission:
 *
 * - every `job.json` (the JobManager record) whose backend is `zgci-h3` and
 *   which carries a hub task id (`task_…`) in `remoteId`;
 * - every `job.json` carrying a task id WITHOUT a backend id (cannot rule out
 *   a zgci submission);
 * - a `zgci-h3` **video** job whose `remoteId` is not a hub task id (it cannot
 *   be resumed safely) or which is still `running` without a remote id (a
 *   submit may be in flight);
 * - `*.log` files mentioning a task id (`task_…`) or a `remoteId` field;
 * - any file that cannot be read/parsed: "undetermined" is treated like a
 *   possible prior submission, so the caller refuses to create.
 *
 * The decision is conservative: exactly one known remote id ⇒ resume the query
 * only; more than one id, an uncertain ledger entry, or any unreadable
 * evidence ⇒ refuse to create and report. No network access happens here.
 * @module
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Task-id shape emitted by the zgci hub (`task_<base62>`). */
export const TASK_ID_RE = /^task_[A-Za-z0-9]{8,}$/;
/** The same shape anywhere in free text (job logs). */
export const REMOTE_ID_RE = /task_[A-Za-z0-9]{8,}/g;
/** `"remoteId": "…"` shapes found in logs. */
const REMOTE_ID_FIELD_RE = /"remoteId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g;
/** A log larger than this is not scanned safely ⇒ undetermined. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 8;

async function listCandidateFiles(root) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && (entry.name === 'job.json' || entry.name.endsWith('.log'))) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

/**
 * Scan an output root for evidence of a prior zgci submission.
 * @param {string} root - artifact root (e.g. `synthmedia-output`).
 * @returns {Promise<{root: string, files: string[], remoteIds: Array<{id: string, source: string}>, indeterminate: Array<{source: string, reason: string}>, rootMissing: boolean}>}
 */
export async function scanExistingRuns(root) {
  const result = { root, files: [], remoteIds: [], indeterminate: [], rootMissing: false };
  let files;
  try {
    await stat(root);
    files = await listCandidateFiles(root);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      result.rootMissing = true;
      return result;
    }
    result.indeterminate.push({ source: root, reason: `cannot list output root: ${err?.code ?? String(err)}` });
    return result;
  }
  result.files = files;
  const seen = new Map();
  const add = (id, source) => {
    const clean = String(id).trim();
    if (!clean) return;
    if (!seen.has(clean)) {
      seen.set(clean, { id: clean, source });
      result.remoteIds.push(seen.get(clean));
    }
  };

  for (const file of files) {
    if (file.endsWith('job.json')) {
      let record;
      try {
        record = JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        result.indeterminate.push({ source: file, reason: `unreadable job record: ${err?.code ?? 'invalid JSON'}` });
        continue;
      }
      const rawRemoteId = typeof record?.remoteId === 'string' ? record.remoteId.trim() : '';
      const remoteId = TASK_ID_RE.test(rawRemoteId) ? rawRemoteId : '';
      const backend = typeof record?.backend === 'string' ? record.backend : '';
      const video = record?.modality === 'video';
      if (remoteId) {
        if (backend === 'zgci-h3') add(remoteId, file);
        else if (backend.length === 0) {
          result.indeterminate.push({
            source: file,
            reason: 'job record carries a remote id but no backend id — cannot rule out a zgci submission',
          });
        }
        // A remote id from another backend is that backend's task, not zgci.
      } else if (rawRemoteId && backend === 'zgci-h3' && video) {
        // A non-hub id on a zgci VIDEO job cannot be queried/resumed safely.
        result.indeterminate.push({
          source: file,
          reason: `zgci-h3 video record carries an unrecognized remote id '${rawRemoteId.slice(0, 40)}'`,
        });
      } else if (!rawRemoteId && backend === 'zgci-h3' && record?.status === 'running') {
        result.indeterminate.push({
          source: file,
          reason: 'in-flight zgci-h3 job without a recorded remote id (a submit may be in progress)',
        });
      }
      continue;
    }
    // *.log
    let text = '';
    try {
      const info = await stat(file);
      if (info.size > MAX_LOG_BYTES) {
        result.indeterminate.push({ source: file, reason: `log is ${info.size} bytes — too large to scan safely` });
        continue;
      }
      text = await readFile(file, 'utf8');
    } catch (err) {
      result.indeterminate.push({ source: file, reason: `unreadable log: ${err?.code ?? String(err)}` });
      continue;
    }
    let found = 0;
    for (const match of text.matchAll(REMOTE_ID_RE)) {
      add(match[0], file);
      found += 1;
    }
    for (const match of text.matchAll(REMOTE_ID_FIELD_RE)) {
      if (!TASK_ID_RE.test(match[1])) continue; // e.g. inline backends write remoteId="inline"
      add(match[1], file);
      found += 1;
    }
    if (found === 0 && /remote[_-]?id/i.test(text) && /zgci/i.test(text)) {
      result.indeterminate.push({
        source: file,
        reason: 'log mentions a zgci remote id but no id could be parsed',
      });
    }
  }
  return result;
}

/**
 * Decide whether the caller may create a new real task.
 *
 * @param {{ledgerEntries?: Array<Record<string, unknown>>, scan: Awaited<ReturnType<typeof scanExistingRuns>>, ledgerPath?: string}} input
 * @returns {{action: 'create'|'resume'|'refuse', code?: number, reason?: string, remoteIds?: Array<{id: string, source: string}>, sources?: string[], notes?: string[]}}
 */
export function decidePreflight({ ledgerEntries = [], scan, ledgerPath = 'ledger' }) {
  const ledgerRemote = [];
  const ledgerUnrecognized = [];
  for (const entry of Array.isArray(ledgerEntries) ? ledgerEntries : []) {
    const id = typeof entry?.remoteId === 'string' ? entry.remoteId.trim() : '';
    if (!id) continue;
    if (TASK_ID_RE.test(id)) ledgerRemote.push({ id, source: ledgerPath });
    else ledgerUnrecognized.push(id);
  }
  const ledgerUncertain = [
    ...(Array.isArray(ledgerEntries) ? ledgerEntries : []).filter(
      (entry) => entry?.state === 'create-uncertain' || entry?.state === 'submitting',
    ),
    ...ledgerUnrecognized.map((id) => ({ state: 'remote-id-unrecognized', remoteId: id })),
  ];

  const merged = new Map();
  for (const item of [...ledgerRemote, ...(scan.remoteIds ?? [])]) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  const ids = [...merged.values()];
  const indeterminate = scan.indeterminate ?? [];

  if (ids.length > 1) {
    return {
      action: 'refuse',
      code: 5,
      reason: 'ambiguous-existing-tasks',
      remoteIds: ids,
      notes: [
        'more than one remote task id is on record; creating a new task could duplicate an existing submission',
        ...ids.map((item) => `remote id ${item.id} <- ${item.source}`),
      ],
    };
  }
  if (ids.length === 1) {
    return {
      action: 'resume',
      remoteId: ids[0].id,
      remoteIds: ids,
      sources: [ids[0].source],
      notes: [
        `existing remote task ${ids[0].id} found at ${ids[0].source}`,
        'querying it is the only allowed action; no new submission will be made',
      ],
    };
  }
  if (ledgerUncertain.length > 0) {
    return {
      action: 'refuse',
      code: 4,
      reason: 'ledger-uncertain',
      notes: [
        'the ledger records an attempt with an unknown create outcome',
        ...ledgerUncertain.map(
          (entry) =>
            `state=${entry.state} at=${entry.at ?? '-'} jobId=${entry.jobId ?? '-'}${entry.remoteId ? ` remoteId=${entry.remoteId}` : ''}`,
        ),
      ],
    };
  }
  if (indeterminate.length > 0) {
    return {
      action: 'refuse',
      code: 4,
      reason: 'indeterminate-existing-evidence',
      notes: [
        'existing output cannot be ruled out as a prior zgci submission, so creating is not safe',
        ...indeterminate.map((item) => `${item.reason}: ${item.source}`),
      ],
    };
  }
  return {
    action: 'create',
    notes: [
      `no ledger entry, no zgci job record and no task id in ${scan.files?.length ?? 0} scanned file(s)`,
    ],
  };
}
