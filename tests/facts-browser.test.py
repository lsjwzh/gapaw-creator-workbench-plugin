#!/usr/bin/env python3
"""保留旧人工模块验收命令入口，统一验证当前本地工作台完整流程。

旧远端接口的兼容性继续由 facts-integration.test.cjs 覆盖。
"""
import runpy
from pathlib import Path

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('local-workbench-browser.test.py')), run_name='__main__')
