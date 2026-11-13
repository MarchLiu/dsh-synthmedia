/**
 * Server-side read-only model-list fetch for the config page.
 *
 * Browsers cannot always GET {baseURL}/v1/models directly (CORS), so the
 * `/synthmedia fetch-models <baseURL>` session command performs the request
 * server-side. READ-ONLY: one GET, no generation call, nothing persisted.
 *
 * Security boundaries:
 *  - protocol allowlist: http/https only (guard rejects file:, data:, …);
 *  - SSRF guard: loopback / private / link-local hosts are refused unless the
 *    base URL exactly matches a built-in preset baseUrl (normalized); the
 *    check runs on the URL literal AND on every address the hostname resolves
 *    to (so DNS names like 127.0.0.1.nip.io cannot front a private target),
 *    and it is repeated right before dispatch to narrow DNS-rebinding windows;
 *    IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) IPv6 forms
 *    are judged by their embedded IPv4 address; HTTP redirects are rejected so
 *    they cannot redirect to a private target;
 *  - optional Bearer token: user-pasted or resolved from a credential NAME
 *    via the host resolver — used in-memory for the single request only,
 *    never stored, logged or echoed into the response;
 *  - the response carries model ids (and display names when the endpoint
 *    provides them), never credential values.
 * @module
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { resolveConfig } from '../config.js';

/** Normalized (trim, strip trailing slashes, lowercase) URL/baseUrl form. */
export function normBase(url: unknown): string {
  return String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * OpenAI-compatible model-list URL for a base: a /v1-style base already
 * carries the version segment (…/v1, …/plan/v3) and only needs /models;
 * anything else gets /v1/models appended. Returns null for empty input.
 */
export function remoteModelsUrl(baseURL: unknown): string | null {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (base === '') return null;
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

const IPV4_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Dotted-quad → octets, or null when not an IPv4 literal. */
function ipv4Octets(text: string): number[] | null {
  const m = IPV4_QUAD.exec(text.trim());
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.some((n) => n > 255) ? null : octets;
}

/** IPv4 loopback / RFC1918 / "this network" / link-local / CGNAT. */
function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = [octets[0]!, octets[1]!];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/**
 * IPv6 text form → eight 16-bit groups (null when unparsable). Accepts `::`
 * compression, an optional zone id, and a trailing dotted-quad.
 */
function ipv6Groups(host: string): number[] | null {
  let text = host.trim().toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return null;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const quad = ipv4Octets(tail);
    if (quad === null) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (piece: string): number[] | null => {
    if (piece === '') return [];
    const out: number[] = [];
    for (const group of piece.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = part(halves[0] ?? '');
  if (left === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = part(halves[1] ?? '');
  if (right === null) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * IPv4 address embedded in an IPv6 form: `::ffff:a.b.c.d` (IPv4-mapped) and
 * the deprecated `::a.b.c.d` (IPv4-compatible). Null for any other address.
 */
function embeddedIpv4(host: string): { readonly octets: number[]; readonly mapped: boolean } | null {
  const groups = ipv6Groups(host);
  if (groups === null) return null;
  const zeroPrefix = (count: number): boolean => groups.slice(0, count).every((v) => v === 0);
  const quadOf = (hi: number, lo: number): number[] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (zeroPrefix(5) && groups[5] === 0xffff) return { octets: quadOf(groups[6]!, groups[7]!), mapped: true };
  if (zeroPrefix(6)) return { octets: quadOf(groups[6]!, groups[7]!), mapped: false };
  return null;
}

/** IPv4/IPv6 loopback, private (RFC1918), link-local or unspecified host. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::' || host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (host.includes(':')) {
    const embedded = embeddedIpv4(host);
    if (embedded === null) return false;
    // `::2` etc. are IPv4-compatible forms of 0.0.0.2 ("this network"). The
    // 0/8 mapping is already covered by the exact `::` case above; keep the
    // rest of ::/96 public unless it maps onto a real private/loopback target.
    if (!embedded.mapped && embedded.octets[0] === 0) return false;
    return isPrivateIpv4(embedded.octets);
  }
  const octets = ipv4Octets(host);
  return octets !== null && isPrivateIpv4(octets);
}

/** One DNS answer (family is advisory; the address is what gets checked). */
export interface HostAddress {
  readonly address: string;
  readonly family?: number;
}

/** Async hostname → addresses resolver; injectable so tests never hit DNS. */
export type HostLookup = (hostname: string) => Promise<readonly HostAddress[]>;

/** Production resolver: every A/AAAA record, not just the first one. */
export const systemLookup: HostLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** True for a URL host that is already an IP literal (no DNS involved). */
function isIpLiteral(host: string): boolean {
  return host.includes(':') || ipv4Octets(host) !== null;
}

type Resolution =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a hostname and reject when ANY answer is loopback/private/
 * link-local. Rejecting on any private record is what stops split-horizon and
 * single-record rebinding tricks; an unresolvable or empty answer set is also
 * refused (a request to it could only fail, so fail closed before dispatch).
 */
export async function resolvePublicHost(host: string, lookup: HostLookup, phase: string): Promise<Resolution> {
  if (isIpLiteral(host)) return { ok: true, addresses: [host] };
  let answers: readonly HostAddress[];
  try {
    answers = await lookup(host);
  } catch (err) {
    return {
      ok: false,
      reason: `主机名 ${host} 解析失败（${phase}）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, reason: `主机名 ${host} 没有解析结果（${phase}），拒绝请求` };
  }
  const addresses: string[] = [];
  for (const answer of answers) {
    const address = String(answer?.address ?? '').trim();
    if (address === '') return { ok: false, reason: `主机名 ${host} 的解析结果缺少地址（${phase}），拒绝请求` };
    if (isPrivateHost(address)) {
      return { ok: false, reason: `主机名 ${host} 解析到私有/回环地址 ${address}（${phase}），拒绝 SSRF` };
    }
    addresses.push(address);
  }
  return { ok: true, addresses };
}

export type GuardedModelListUrl =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/** Guard knobs: the DNS resolver is injectable so tests stay offline. */
export interface GuardOptions {
  readonly lookup?: HostLookup;
}

/**
 * SSRF guard for one model-list URL: http/https only, no embedded
 * credentials, and loopback/private/link-local hosts refused unless the base
 * URL exactly matches one of the allowed preset baseUrls (normalized — an
 * operator-configured preset is an explicit allowlist entry). The hostname is
 * then resolved and EVERY answer must be public; that catches names such as
 * 127.0.0.1.nip.io whose literal host is public but whose DNS answer is not.
 * Async because resolution is async; a preset match skips resolution.
 */
export async function guardModelListUrl(
  baseURL: unknown,
  allowedPresetBases: readonly string[] = [],
  opts: GuardOptions = {},
): Promise<GuardedModelListUrl> {
  const url = remoteModelsUrl(baseURL);
  if (url === null) return { ok: false, reason: 'baseURL 为空' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `baseURL 不是合法 URL：${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `仅允许 http/https 协议（收到 ${parsed.protocol}）` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'baseURL 不允许内嵌凭据（user:pass@）' };
  }
  // An exact preset match is the operator's explicit allowlist entry: it is
  // allowed both for literal private hosts and for names resolving privately.
  if (allowedPresetBases.some((b) => normBase(b) === normBase(baseURL))) return { ok: true, url };
  const host = parsed.hostname.replace(/^\[|\]$/g, '').trim();
  if (isPrivateHost(host)) {
    return { ok: false, reason: `拒绝私有/回环地址 ${parsed.hostname}（除非 baseURL 精确命中内置 preset）` };
  }
  const resolved = await resolvePublicHost(host, opts.lookup ?? systemLookup, '连接前');
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, url };
}

export type RemoteModelsResult =
  | { readonly ok: true; readonly models: ReadonlyArray<{ readonly id: string; readonly name?: string }> }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetch the live model list for one base URL. `token` (user-pasted) and
 * `resolveCredential` (host credential resolver by env NAME) feed the single
 * request's Authorization header in memory only; neither ever reaches the
 * returned value. Any failure resolves {ok:false, reason} — no throw.
 */
export async function fetchRemoteModels(
  baseURL: unknown,
  opts: {
    readonly allowedPresetBases?: readonly string[];
    readonly token?: string | undefined;
    readonly resolveCredential?: ((name: string) => Promise<string | undefined>) | undefined;
    readonly authEnv?: string | undefined;
    readonly fetchImpl?: typeof fetch;
    readonly lookup?: HostLookup;
    readonly timeoutMs?: number;
  } = {},
): Promise<RemoteModelsResult> {
  const presetBases = opts.allowedPresetBases ?? [];
  const guard = await guardModelListUrl(baseURL, presetBases, opts.lookup ? { lookup: opts.lookup } : {});
  if (!guard.ok) return { ok: false, reason: guard.reason };
  // Narrow the DNS-rebinding window: the guard resolved the name once, but the
  // connection resolves it again. Re-resolve right before dispatch and reject
  // if the answer set has changed to include a private address.
  const presetAllowed = presetBases.some((b) => normBase(b) === normBase(baseURL));
  if (!presetAllowed) {
    let host = '';
    try {
      host = new URL(guard.url).hostname.replace(/^\[|\]$/g, '').trim();
    } catch {
      return { ok: false, reason: `baseURL 不是合法 URL：${guard.url}` };
    }
    const recheck = await resolvePublicHost(host, opts.lookup ?? systemLookup, '发送请求前');
    if (!recheck.ok) return { ok: false, reason: recheck.reason };
  }
  let authorization: string | undefined;
  const pasted = String(opts.token ?? '').trim();
  if (pasted !== '') {
    authorization = `Bearer ${pasted}`;
  } else if (opts.authEnv && typeof opts.resolveCredential === 'function') {
    try {
      const resolved = await opts.resolveCredential(opts.authEnv);
      if (resolved) authorization = `Bearer ${resolved}`;
    } catch {
      // Resolver failure = anonymous request, never an error surface.
    }
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const answer = await doFetch(guard.url, {
      method: 'GET',
      headers: authorization !== undefined ? { authorization } : {},
      // Never follow a redirect: the initial URL may be public while its
      // Location target is loopback/private, bypassing guardModelListUrl.
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!answer.ok) return { ok: false, reason: `HTTP ${answer.status}` };
    const body: unknown = await answer.json();
    const list: unknown = body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['data'])
      ? (body as Record<string, unknown>)['data']
      : body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['models'])
        ? (body as Record<string, unknown>)['models']
        : Array.isArray(body) ? body : [];
    const models: Array<{ id: string; name?: string }> = [];
    const seen = new Set<string>();
    for (const item of list as unknown[]) {
      const id = item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>)['id']
        : item;
      if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
      seen.add(id);
      const name = item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>)['name'] === 'string'
        ? (item as Record<string, unknown>)['name'] as string
        : undefined;
      models.push(name !== undefined ? { id, name } : { id });
    }
    if (models.length === 0) return { ok: false, reason: '响应中没有模型条目' };
    return { ok: true, models };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Preset baseUrls of the effective config (the explicit allowlist). */
export function presetBaseUrls(config: Record<string, unknown>): string[] {
  try {
    const resolved = resolveConfig(config);
    return Object.values(resolved.backends).map((b) => b.baseUrl);
  } catch {
    return [];
  }
}
