import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { FetchModule } from '../../../fetch/fetch.module';
import { ImContactFetchService } from './im-contact-fetch.service';
import { ImContactConfigService } from './im-contact-config.service';
import { ImContactController } from './im-contact.controller';

/**
 * IM 电联看板独立模块（2026-10-17 新建）。
 *
 * 独立看板：取数 / 落盘 / 配置代码全部自管，不与其他看板共用业务代码。
 *  - `ImContactFetchService`：Quark 报表 473269 取数 + 扁平化 + 落盘
 *    `backend/data/im-contact-实时.json`（仅复用取数 primitive `ContactImFetchService`）；
 *  - `ImContactConfigService`：「展示站点」配置（由 ProxyModule 的
 *    `im-contact/{*path}` 通配在命中 isConfigPath 时改派 /teams）；
 *  - `ImContactController`：看板自身 HTTP 入口（`/api/im-contact-fetch/refresh`、
 *    `/api/im-contact-fetch/status`），前缀避开通配，随本模块被 ProxyModule 依赖
 *    而先于通配注册。
 *
 * 计算层在 Python `analytics/im_contact/`（独立包），经 `GET /api/im-contact/data`
 * 通配转发访问。
 */
@Module({
  imports: [ConfigModule, FetchModule],
  controllers: [ImContactController],
  providers: [ImContactFetchService, ImContactConfigService],
  exports: [ImContactConfigService],
})
export class ImContactModule {}
