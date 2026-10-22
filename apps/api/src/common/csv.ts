/**
 * 极简 RFC4180 CSV 解析（对应 Python csv 模块的默认方言）。
 * 支持：引号包裹、字段内逗号/换行、双引号转义、CRLF/LF、UTF-8 BOM。
 */

/** 解析为二维数组（首行为表头也照常返回）。 */
export function parseCsvRows(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 首行作表头，其余按表头映射为对象（对应 csv.DictReader）。 */
export function csvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    // 跳过完全空行（DictReader 不给空行产出记录）
    if (r.length === 1 && r[0].trim() === '') continue;
    const rec: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) rec[header[j]] = r[j] ?? '';
    out.push(rec);
  }
  return out;
}
