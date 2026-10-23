import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 风神（Aeolus）登录凭据的**可读写**存储。
 *
 * 历史：凭据原本只能手写 `apps/api/aeolus_sdk/credentials.json`（gitignored，明文），
 * 现归并到 `apps/api/runtime/aeolus_sdk/credentials.json`（与 cookie.txt 同目录，运行时产物统一在 runtime/）。
 * 现提供「系统设置 → 风神设置」UI 直接维护账号/密码，落盘到**同一文件**
 * （与 `AeolusLoginService.credentials()` 读取路径逐字一致，故登录逻辑无需改动）。
 *
 * 安全约定（与 `bot-config.service.ts` 的凭据分组一致）：
 *  · 读取：`masked()` 脱敏快照（账号脱敏 + 是否已设密码），明文密码永不外泄；
 *    `read()` 仅供运行时登录取真实凭据。
 *  · 写入：`save()` 原子写盘，权限 0o600；密码留空表示「沿用原密码」（首次配置必须填）。
 *  · 凭据文件（`apps/api/runtime/aeolus_sdk/credentials.json`，由 UI 维护）为**唯一**来源；
 *    风神账号密码只经「系统设置 → 风神设置」保存，不读取任何环境变量、不落 .env。
 */
@Injectable()
export class AeolusCredentialsService {
  private readonly logger = new Logger(AeolusCredentialsService.name);
  private readonly file: string;

  constructor(private readonly nest: NestConfigService) {
    const root = path.resolve(
      this.nest.get<string>('PROJECT_ROOT') || path.resolve(process.cwd(), '..'),
    );
    // 与 AeolusLoginService 的 credFile 路径逐字一致，确保单一来源。
    // 运行时凭据统一归到 runtime/aeolus_sdk/（与 cookie.txt 同目录，不再散落 apps/api/aeolus_sdk/）。
    this.file = path.join(root, 'apps', 'api', 'runtime', 'aeolus_sdk', 'credentials.json');
  }

  private readFile(): { account?: string; password?: string } {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      return d && typeof d === 'object' ? d : {};
    } catch {
      return {};
    }
  }

  private writeFile(obj: { account: string; password: string }): void {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* 权限微调失败不影响写入 */
    }
  }

  /** 运行时真实凭据（登录用），仅来自 UI 维护的 credentials.json。 */
  read(): { account: string; password: string } {
    const d = this.readFile();
    if (d?.account && d?.password) {
      return { account: String(d.account), password: String(d.password) };
    }
    return { account: '', password: '' };
  }

  /** 脱敏快照（前端展示用）：永不外泄明文密码。凭据仅来自文件，故 source 只可能是 'file' 或 'none'。 */
  masked(): { ok: boolean; hasAccount: boolean; hasPassword: boolean; account?: string; accountHint?: string; source: 'file' | 'none' } {
    const d = this.readFile();
    const acc = d?.account ? String(d.account) : '';
    const pwd = d?.password ? String(d.password) : '';
    if (acc && pwd) {
      return {
        ok: true,
        hasAccount: true,
        hasPassword: true,
        account: acc,
        accountHint: this.hint(acc),
        source: 'file',
      };
    }
    return { ok: true, hasAccount: !!acc, hasPassword: !!pwd, source: 'none' };
  }

  private hint(acc: string): string | undefined {
    if (!acc) return undefined;
    if (acc.length <= 5) return acc[0] + '****';
    return acc.slice(0, 3) + '****' + acc.slice(-2);
  }

  /**
   * 保存凭据（整体覆盖账号；密码留空 = 沿用原密码）。
   * 首次配置（文件无密码）必须填写密码，否则报错。
   */
  save(input: { account?: unknown; password?: unknown }): { ok: boolean; error?: string } & ReturnType<AeolusCredentialsService['masked']> {
    const account = typeof input?.account === 'string' ? input.account.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!account) return { ...this.masked(), ok: false, error: '账号不能为空' };
    const existing = this.readFile();
    const finalPwd = password.length ? password : (existing.password || '');
    if (!finalPwd) {
      return { ...this.masked(), ok: false, error: '密码不能为空（首次配置须填写密码；之后修改可留空保持不变）' };
    }
    this.writeFile({ account, password: finalPwd });
    this.logger.log('风神凭据已通过 UI 保存（账号 %s）', this.hint(account));
    return { ...this.masked() };
  }
}
