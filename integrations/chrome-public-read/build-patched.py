#!/usr/bin/env python3
"""历史构建入口已停用；公开页面接口已由 MultiCC 随包分发。"""
import sys


def main():
    sys.exit(
        '此构建入口已停用：MultiCC 随包分发的 Chrome 隔离插件 1.6.4 已内置只读桥。'
        '请在 MultiCC 仓库通过正常分支维护浏览器插件；'
        '不要用本目录补丁覆盖 MultiCC 主仓 plugins/chrome-proxy-launcher。'
        '详情见同目录 README.md。'
    )


if __name__ == '__main__':
    main()
