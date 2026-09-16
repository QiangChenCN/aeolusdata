#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""不满意单（违规处罚）自动化 —— 独立应用包。

模块：
  config        配置（表格/群/站点/LLM，敏感项走环境变量）
  fetcher       风神拉数 + 剔超时/不成立
  store         SQLite 状态库
  sheet_writer  在线表格 D 列首空行写入 + 反馈回填
  renderer      Pillow 美化出图
  ding_out      钉钉发送
  llm_judge     大模型合规判定（含规则降级）
  scheduler     APScheduler 定时任务
  callback      FastAPI 入站回调（需钉钉后台配置）
  main          入口
"""
__version__ = "0.2.0"
