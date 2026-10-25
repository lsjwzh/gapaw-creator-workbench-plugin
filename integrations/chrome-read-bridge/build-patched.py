#!/usr/bin/env python3
"""只读复制经过校验的 1.5.0 源码，在新的隔离目录应用桥接补丁。"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, help="Chrome 1.5.0 源码目录（只读）")
    parser.add_argument("--output", required=True, type=pathlib.Path, help="尚不存在的隔离源码输出目录")
    parser.add_argument("--build", action="store_true", help="在输出目录构建调试二进制")
    args = parser.parse_args()
    bundle = pathlib.Path(__file__).resolve().parent
    source = args.source.resolve(strict=True)
    output = args.output.resolve(strict=False)
    if output.exists() or output.is_symlink():
        raise ValueError("输出目录已存在；为保留既有内容，请指定新的隔离目录")
    if source == output or source in output.parents:
        raise ValueError("输出目录不能位于只读来源目录内部")
    checksums = json.loads((bundle / "source-checksums.json").read_text())
    for relative, expected in checksums.items():
        path = source / relative
        parents = list(path.parents)
        parents = parents[:parents.index(source)]
        if path.is_symlink() or any(parent.is_symlink() for parent in parents) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"来源源码不符合已验证的 1.5.0 基线：{relative}")
    manifest = json.loads((source / "plugin.json").read_text())
    if manifest.get("id") != "chrome-proxy-launcher" or manifest.get("version") != "1.5.0":
        raise ValueError("只支持经过校验的 Chrome 插件 1.5.0 源码")
    # 只复制源码与扩展模板；不读取 bin、用户资料、订阅、运行数据或构建缓存。
    output.mkdir(parents=True)
    for relative in [*checksums, "README.md"]:
        item = source / relative
        if item.is_symlink():
            raise ValueError(f"不复制符号链接：{relative}")
        (output / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, output / relative)
    patch = str(bundle / "chrome-1.5.0-read-bridge.patch")
    for dry in [True, False]:
        command = ["patch", "--batch", "--forward", "-p1", "-i", patch]
        if dry:
            command.append("--dry-run")
        result = subprocess.run(command, cwd=output, text=True, capture_output=True)
        if result.returncode:
            raise ValueError("补丁校验或应用失败；来源目录未被修改，隔离输出保留供检查")
    shutil.copy2(bundle / "read_bridge.rs", output / "src/read_bridge.rs")
    shutil.copy2(bundle / "read_bridge_integration.rs", output / "src/read_bridge_integration.rs")
    shutil.copy2(bundle / "Cargo.lock", output / "Cargo.lock")
    if args.build:
        subprocess.run(["cargo", "build", "--locked", "--manifest-path", str(output / "Cargo.toml")], check=True)
    print(f"已校验并应用受限只读桥接补丁：{output}")
    print("来源源码未修改；此输出尚未安装或替换运行插件。")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"未完成：{error}", file=sys.stderr)
        sys.exit(1)
