import { request, withToken } from './request.js';

export function runTask(taskId, args) {
  // 后端 POST /api/run 的 DTO 要求 { items:[{ task_id, args }] }（全局 ValidationPipe 开了
  // forbidNonWhitelisted，扁平写法 { task_id, args } 会被 400 拒绝，任务永远进不了执行器）。
  return request('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ task_id: taskId, args }] }),
  });
}

export function stopRun(runId) {
  return request('/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId }),
  });
}

export function fetchLog(runId) {
  return request('/log?run_id=' + encodeURIComponent(runId));
}

export function fetchArtifacts(taskId) {
  return request('/files?task_id=' + encodeURIComponent(taskId));
}

/** 文件预览/下载 URL（img/iframe/a 用，带 token 查询） */
export function artifactUrl(rel) {
  return withToken('/api/file?path=' + encodeURIComponent(rel));
}
export function sheetUrl(rel) {
  return withToken('/api/sheet?path=' + encodeURIComponent(rel));
}
