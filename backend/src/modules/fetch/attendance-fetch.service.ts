import { Injectable } from '@nestjs/common';
import { AeolusCookieService } from './aeolus-cookie.service';

/**
 * 实时考勤取数（移植自 get_data/attendance.py，单一来源）。
 *
 * POST xtop.fs.special.realtimeattendance.listAttendance/1.0
 * body: params.request = { teamId, timeCode, shiftedOffline: 0 }
 */
export const ATTENDANCE_API =
  'https://httpizza.ele.me/xtop/xtop.fs.special.realtimeattendance.listAttendance/1.0';

const STATIC_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
  'content-type': 'application/json',
  origin: 'https://r.ele.me',
  referer: 'https://r.ele.me/pikipek/schedule.html?platform=fs&subType=ub',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
};

@Injectable()
export class AttendanceFetchService {
  constructor(private readonly cookies: AeolusCookieService) {}

  /** 单站点实时考勤 → 接口原始 JSON（含 result.data 骑手列表）。 */
  async fetchTeam(
    teamId: number | string,
    timeCode: string | number,
    cookie?: string,
  ): Promise<Record<string, any>> {
    const ck = cookie || (await this.cookies.ensure());
    const body = JSON.stringify({
      params: { request: { teamId, timeCode: String(timeCode), shiftedOffline: 0 } },
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(ATTENDANCE_API, {
        method: 'POST',
        headers: { ...STATIC_HEADERS, cookie: ck },
        body,
        signal: ctrl.signal,
      });
      return (await res.json()) as Record<string, any>;
    } finally {
      clearTimeout(timer);
    }
  }
}
