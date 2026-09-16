# -*- coding: utf-8 -*-
"""用模拟数据渲染 5 类报表预览图，验证统一配色 + 新布局效果（不依赖线上登录）。"""
import os
import sys
_HERE = os.path.dirname(os.path.abspath(__file__))       # .../tools
_ROOT = os.path.dirname(_HERE)                          # 项目根
sys.path.insert(0, os.path.join(_ROOT, "common"))
import report_render as R

OUT = os.path.join(_ROOT, "preview")                    # 预览图仍落在项目根 preview/
os.makedirs(OUT, exist_ok=True)


def mock_attendance():
    rows = [
        {"knightName": "张三", "mobile": "13800001111", "schedule": "晚高峰", "workStatus": "离线",
         "fullDayOnline": "0", "fullDayOrders": 0, "slotTarget": "2h", "slotOrderTarget": 30},
        {"knightName": "李四", "mobile": "13800002222", "schedule": "晚高峰/夜宵1", "workStatus": "小休",
         "fullDayOnline": "1h20m", "fullDayOrders": 5, "slotTarget": "2h", "slotOrderTarget": 30},
        {"knightName": "王五", "mobile": "13800003333", "schedule": "晚高峰", "workStatus": "离线",
         "fullDayOnline": "0", "fullDayOrders": 0, "slotTarget": "2h", "slotOrderTarget": 30},
    ]
    return R.render_attendance_absent(rows, 140, "晚高峰", "917521136", 42,
                                       out_path=os.path.join(OUT, "preview_attendance.png"))


def mock_all_teams():
    team_items = [(917521130, "东莞市黄江镇站-UB"), (917521136, "东莞市长安万科站-UB"),
                  (917521139, "东莞市大岭山大学城站-UB")]
    stats = {917521130: (12, 10, 1, 1, 0, 0), 917521136: (15, 12, 2, 1, 1, 0), 917521139: (9, 8, 0, 1, 0, 0)}
    all_rows = [
        {"knightName": "赵六", "site": "东莞市黄江镇站-UB", "state": "下线", "delivering": 0,
         "slotFinish": 0, "slotValid": "0", "fullFinish": 0, "fullValid": "0"},
        {"knightName": "孙七", "site": "东莞市黄江镇站-UB", "state": "小休", "delivering": 1,
         "slotFinish": 2, "slotValid": "0", "fullFinish": 3, "fullValid": "0"},
        {"knightName": "周八", "site": "东莞市长安万科站-UB", "state": "下线", "delivering": 2,
         "slotFinish": 1, "slotValid": "0", "fullFinish": 2, "fullValid": "1h"},
    ]
    return R.render_all_teams(all_rows, "晚高峰", "17:30-20:00", team_items, stats,
                              out_path=os.path.join(OUT, "preview_all_teams.png"))


def mock_appeal():
    rows = [
        {"违规时间": "2026-08-19 18:23", "运单号": "SF1234567890123", "骑手信息": "张三(10086)",
         "所属团队": "东莞市黄江镇站-UB", "站点": "黄江", "违规分类": "虚假送达", "违规类型": "定位偏差",
         "违规原因": "定位漂移超50米", "申诉状态": "待申诉", "申诉剩余时间": "19小时"},
        {"违规时间": "2026-08-19 19:10", "运单号": "SF1234567890456", "骑手信息": "李四(10087)",
         "所属团队": "东莞市长安万科站-UB", "站点": "万科", "违规分类": "投诉", "违规类型": "服务态度",
         "违规原因": "顾客投诉态度差", "申诉状态": "待申诉", "申诉剩余时间": "21小时"},
        {"违规时间": "2026-08-19 19:45", "运单号": "SF1234567890789", "骑手信息": "王五(10088)",
         "所属团队": "东莞市大岭山大学城站-UB", "站点": "大岭山大学城", "违规分类": "提前点送达",
         "违规类型": "违规操作", "违规原因": "提前标记送达", "申诉状态": "待申诉", "申诉剩余时间": "18小时"},
    ]
    return R.render_appeal(rows, "2026-08-19", out_path=os.path.join(OUT, "preview_appeal.png"))


def mock_equipment():
    rows = [
        ["20260819", "10086", "张三", "917521130", "东莞市黄江镇站-UB", "30", "0", "1", "0"],
        ["20260819", "10087", "李四", "917521136", "东莞市长安万科站-UB", "45", "1", "0", "1"],
        ["20260819", "10088", "王五", "917521139", "东莞市大岭山大学城站-UB", "12", "0", "0", "0"],
    ]
    return R.render_equipment(rows, 120, "2026-08-19", out_path=os.path.join(OUT, "preview_equipment.png"))


def mock_tasks():
    tasks = [
        {"taskName": "黄江站早班配送巡检", "taskObject": "东莞市黄江镇站-UB", "status": "已开始",
         "taskExpireTime": "2026-08-19T23:59:59", "remaining": "8小时", "executorName": "印立澳"},
        {"taskName": "万科站装备抽查", "taskObject": "东莞市长安万科站-UB", "status": "已开始",
         "taskExpireTime": "2026-08-20T12:00:00", "remaining": "1天4小时", "executorName": "陈冬冬"},
        {"taskName": "大岭山异常单复核", "taskObject": "东莞市大岭山大学城站-UB", "status": "已开始",
         "taskExpireTime": "2026-08-19T20:30:00", "remaining": "已过期", "executorName": "房志才"},
    ]
    return R.render_tasks(tasks, out_path=os.path.join(OUT, "preview_tasks.png"))


if __name__ == "__main__":
    print(mock_attendance())
    print(mock_all_teams())
    print(mock_appeal())
    print(mock_equipment())
    print(mock_tasks())
    print("全部预览已生成 ->", OUT)
