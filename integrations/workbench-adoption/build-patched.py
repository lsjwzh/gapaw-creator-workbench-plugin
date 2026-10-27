#!/usr/bin/env python3
"""只读校验旧工作台七个源码文件，并在新隔离目录应用候选区兼容补丁。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def build(source, output):
    bundle = Path(__file__).resolve().parent
    source = Path(source).resolve(strict=True)
    requested = Path(output)
    if requested.exists() or requested.is_symlink():
        raise ValueError("输出目录必须尚不存在")
    output = requested.resolve(strict=False)
    if output == source or source in output.parents:
        raise ValueError("输出目录不能位于只读来源内部")
    checks = json.loads((bundle / "source-checksums.json").read_text())
    if set(checks) != {"server.py", "store.py", "app.js", "index.html", "style.css", "conversations.html", "conversations.js"}:
        raise ValueError("来源白名单无效")
    for name, expected in checks.items():
        path = source / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("来源源码与已验证基线不一致：" + name)
    output.mkdir(parents=True)
    for name in checks:
        shutil.copy2(source / name, output / name)
    patch = bundle / "creator-outreach-selection.patch"
    for dry in (True, False):
        args = ["patch", "--batch", "--forward", "-p1", "-i", str(patch)]
        if dry:
            args.append("--dry-run")
        result = subprocess.run(args, cwd=output, capture_output=True, text=True)
        if result.returncode:
            raise ValueError("兼容补丁校验或应用失败；来源未修改")
    shutil.copy2(bundle / "workbench_bridge.py", output / "workbench_bridge.py")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print("已生成隔离源码副本：" + str(build(args.source, args.output)))
        print("仅复制七个源码文件和兼容桥；没有复制数据、seed或登录态，没有初始化或部署。")
    except (OSError, ValueError) as error:
        parser.exit(1, "未完成：" + str(error) + "\n")
