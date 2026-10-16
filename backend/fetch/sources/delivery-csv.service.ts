import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { FIELD_CN, FIELD_ORDER } from '../storage/delivery-columns';

/** 运单明细 CSV 导出（移植 jobs/delivery/download_delivery.py 的 write_csv）。 */
@Injectable()
export class DeliveryCsvService {
  readonly outDir: string;

  constructor(config: ConfigService) {
    const root = path.resolve(
      config.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    this.outDir = path.join(root, 'backend', 'data', 'jobs', 'delivery', 'out');
  }

  private cell(v: unknown): string {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** 写 CSV（UTF-8 BOM，中文表头）；额外字段追加在末尾。 */
  writeCsv(rows: Record<string, any>[], pathOrName: string): string {
    const abs = path.isAbsolute(pathOrName) ? pathOrName : path.join(this.outDir, pathOrName);
    const extra: string[] = [];
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!FIELD_ORDER.includes(k) && !extra.includes(k)) extra.push(k);
      }
    }
    const header = [...FIELD_ORDER, ...extra].map((c) => FIELD_CN[c] ?? c);
    const lines = [header, ...rows.map((r) => [...FIELD_ORDER, ...extra].map((c) => r[c] ?? ''))];
    const csv = lines.map((l) => l.map((v) => this.cell(v)).join(',')).join('\r\n');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '\uFEFF' + csv + '\r\n', 'utf-8');
    return abs;
  }
}
