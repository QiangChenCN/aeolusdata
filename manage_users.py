#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""RBAC 用户管理 CLI（轻量，直接读写 .users.json，复用 auth.py 的哈希/校验）。

用法：
  python manage_users.py add <用户名> <角色> [--pw 密码]
  python manage_users.py list
  python manage_users.py disable <用户名>
  python manage_users.py enable  <用户名>
  python manage_users.py reset-pw <用户名> [--pw 密码]

角色取值：admin / operator / viewer
不传 --pw 时交互式输入（终端隐藏回显）。
"""
import os
import sys
import getpass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import auth


def _pw(args):
    if "--pw" in args:
        return args[args.index("--pw") + 1]
    return getpass.getpass("密码: ")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    try:
        if cmd == "add":
            user, role = args[1], args[2]
            auth.add_user(user, _pw(args), role)
            print("已创建用户：%s（角色 %s）" % (user, role))
        elif cmd == "list":
            users = auth.list_users()
            if not users:
                print("（暂无用户，首次启动已自动创建 admin）")
                return
            print("%-20s %-10s %s" % ("用户名", "角色", "状态"))
            for u in users:
                st = "已禁用" if u.get("disabled") else "正常"
                print("%-20s %-10s %s" % (u.get("username"), u.get("role"), st))
        elif cmd == "disable":
            print("已禁用" if auth.set_disabled(args[1], True) else "用户不存在")
        elif cmd == "enable":
            print("已启用" if auth.set_disabled(args[1], False) else "用户不存在")
        elif cmd == "reset-pw":
            if auth.reset_password(args[1], _pw(args)):
                print("已重置密码：%s" % args[1])
            else:
                print("用户不存在")
        else:
            print("未知命令：%s" % cmd)
            print(__doc__)
    except ValueError as e:
        print("错误：%s" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
