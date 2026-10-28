/**
 * 网络错误描述 + 现场取证工具。
 *
 * Node 的 `fetch` 失败时只给笼统的 `fetch failed`（`TypeError`），真正原因
 * （DNS 失败 / TLS 握手失败 / 连接被重置 / 超时）挂在 `cause` 上。以前各处只拼
 * `message`，日志与前端看到的就是一句 `net fetch failed`，既无法远程定位，
 * 也触发不了 `diagnose()` 的网络关键字匹配（详见 tasks/diagnostics.util.ts）。
 *
 * 统一由本文件展开 `code` 与 `cause.code/errno/message`；`probeNet()` 则在失败瞬间
 * 独立探测一次 DNS + TCP，用来区分「机器/上游网络不通」与「本进程网络栈自己卡死」。
 */
import * as dns from 'dns';
import * as net from 'net';

/** `code=xxx cause=yyy` 形式的诊断后缀（无可用信息时为空串）。 */
export function netCauseSuffix(ex: unknown): string {
  const e = ex as Error & {
    code?: string;
    errno?: number;
    cause?: { code?: string; errno?: number; message?: string };
  };
  const ownErrno = e?.code ? ` code=${e.code}` : '';
  const c = e?.cause;
  const cause = c ? ` cause=${c.code || c.errno || c.message || '未知'}` : '';
  return `${ownErrno}${cause}`;
}

/**
 * 网络错误的**完整**描述：`{prefix}: {message} code=... cause=...`。
 * 供自定义前缀的调用方（如「登录页请求失败」）使用。
 */
export function describeNetError(prefix: string, ex: unknown): Error {
  const e = ex as Error;
  return new Error(`${prefix}: ${e?.message || String(ex)}${netCauseSuffix(ex)}`);
}

/**
 * `net {message} code=... cause=...` —— 取数层（delivery-query / teams / schedule 等）
 * 统一用这个前缀，历史判定 `msg.startsWith('net ')`（delivery-raw.service.ts）依赖它，勿改。
 */
export function netError(ex: unknown): Error {
  const e = ex as Error;
  return new Error(`net ${e?.message || String(ex)}${netCauseSuffix(ex)}`);
}

/** 探测超时兜底串的统一后缀（提示这只是诊断信息缺失，不代表主流程失败）。 */
const PROBE_TIMEOUT_HINT = '（探测自身超时已放弃，非主流程失败）';

/**
 * 硬超时：任何探测都**不能**无限期挂住调用方。
 *
 * 为什么必须：宿主 DNS 异常（WSL 的 NAT DNS 高发）时 `dns.promises.lookup` 可能
 * 既不 resolve 也不 reject，socket 一直 ESTABLISHED。它原本被用在「阶段 0 取数失败」
 * 的 catch 里做现场取证 —— 取证挂死 ⇒ catch 永不返回 ⇒ `finally` 不执行 ⇒ 刷新的
 * 「单飞」标记 `running` 永久为 true，前端按钮从此卡在「刷新中…」。
 * 诊断信息永远不该有高于业务流程的优先级，故一律用超时 + 降级串兜住。
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: (elapsedMs: number) => T,
): Promise<T> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback(Date.now() - t0)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 失败瞬间的**现场取证**：独立做一次 DNS 解析 + TCP 443 连接，绕开 undici 的连接池。
 *
 * 为什么需要：`net fetch failed` 只能说明这次请求没成功，说明不了是哪一层坏了。
 * 同样的报错背后可能是三种完全不同的故障 ——
 *   ① 本机/宿主网络或 DNS 代理不可用（WSL 的 10.255.255.254 NAT DNS 高发）
 *   ② 上游拒绝/黑洞（风控、连接重置）
 *   ③ 本进程自己的网络栈卡死（长跑进程的 undici 连接池 / DNS 缓存，重启即恢复）
 * 探测本身不走 fetch：DNS/连接都正常却仍 fetch failed，就基本坐实 ③。
 *
 * 返回可直接进日志 / 前端提示的短串，如 `dns=ok(106.11.237.245) 3ms tcp=ok 12ms`。
 */
export async function probeNet(host: string, port = 443, timeoutMs = 5000): Promise<string> {
  const dnsPart = await probeDns(host, timeoutMs);
  const tcpPart = await probeTcp(host, port, timeoutMs);
  return `${dnsPart} ${tcpPart}`;
}

/** 事件循环延迟：约 100ms 的定时器实际晚了多久。越大说明 loop 被同步任务卡得越死。 */
function loopLag(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const expected = 100;
    setTimeout(() => resolve(Date.now() - t0 - expected), expected);
  });
}

/**
 * 进程级体检：在 `probeNet()` 之上再量一次事件循环延迟 / 内存 / 运行时长。
 *
 * 判据（写进日志与前端提示，供现场直接读）：
 *   · `dns=ok tcp=ok` 却仍 fetch failed，且 `loop` 正常 → 本进程对外连接池自己的问题；
 *   · `loop` 达数百毫秒以上 → 事件循环被同步任务（如大 xlsx 解析）堵住，I/O 全部超时；
 *   · `dns/tcp` 也失败 → 机器 / 宿主网络问题，与本进程无关。
 */
export async function probeRuntime(host: string, port = 443, timeoutMs = 5000): Promise<string> {
  // 整体再兜一层：即使下面每一段都各自有超时，任意一段出现预期外的挂起（如 loopLag 的
  // 定时器被拖到极晚）也不能把调用方一起拖死。
  const totalMs = timeoutMs * 2 + 2000;
  return withTimeout(
    (async () => {
      const [net, lag] = await Promise.all([probeNet(host, port, timeoutMs), loopLag()]);
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      return `${net} loop=${lag}ms rss=${rss}MB uptime=${Math.floor(process.uptime())}s`;
    })(),
    totalMs,
    (elapsed) =>
      `probe=timeout(>${elapsed}ms)${PROBE_TIMEOUT_HINT} ` +
      `rss=${Math.round(process.memoryUsage().rss / 1048576)}MB uptime=${Math.floor(process.uptime())}s`,
  );
}

async function probeDns(host: string, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  // `dns.promises.lookup` 无超时参数：宿主 DNS 无响应时会永久 pending（只留一条 ESTABLISHED
  // 的 53 端口连接）。这里必须自行 race 一个定时器，否则调用方会被永久挂住。
  return withTimeout(
    dns.promises.lookup(host, { all: true }).then(
      (addrs) => `dns=ok(${addrs.map((a) => a.address).join('/')}) ${Date.now() - t0}ms`,
      (e: Error & { code?: string }) => `dns=fail(${e.code || e.message}) ${Date.now() - t0}ms`,
    ),
    timeoutMs,
    (elapsed) => `dns=timeout(>${elapsed}ms, 宿主 DNS 无响应)${PROBE_TIMEOUT_HINT}`,
  );
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  return new Promise<string>((resolve) => {
    const sock = net.connect({ host, port });
    const done = (s: string) => {
      sock.destroy();
      resolve(s);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(`tcp=ok ${Date.now() - t0}ms`));
    sock.once('timeout', () => done(`tcp=timeout ${Date.now() - t0}ms`));
    sock.once('error', (e: Error & { code?: string }) =>
      done(`tcp=fail(${e.code || e.message}) ${Date.now() - t0}ms`),
    );
  });
}
