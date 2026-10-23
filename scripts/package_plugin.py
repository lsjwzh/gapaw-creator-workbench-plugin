#!/usr/bin/env python3
"""构建可复制的达人工作台插件；只负责发行文件，不执行插件。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import uuid
import zipfile


PLUGIN_ID = "gapaw-creator-workbench"
TARGET_DIR = Path("/tmp/gapaw-creator-plugin-target")
SKIP_NAMES = {".git", ".DS_Store", "__pycache__", "target", "node_modules", "requirements", "docs", "prototype", "data", "secrets"}
SUM_FILE = "SHA256SUMS"


def host_platform():
    systems = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}
    machines = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}
    try:
        return systems[platform.system()] + "-" + machines[platform.machine()]
    except KeyError as error:
        raise ValueError("当前操作系统或架构尚不支持发行") from error


def main_project(source):
    try:
        result = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=source,
                                check=True, text=True, capture_output=True)
        common = Path(result.stdout.strip()).resolve()
        if common.name == ".git":
            return common.parent
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return source


def manifest_at(directory):
    path = directory / "plugin.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError("缺少真实的 plugin.json 文件：" + str(directory))
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("id") != PLUGIN_ID:
        raise ValueError("插件清单标识不匹配，拒绝覆盖：" + str(directory))
    version = manifest.get("version", "")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
        raise ValueError("插件版本必须是合法版本号")
    return manifest


def copy_tree(source, destination):
    if source.is_symlink() or not source.is_dir():
        raise ValueError("发行资源目录缺失或使用了符号链接：" + str(source))
    destination.mkdir(parents=True)
    for child in sorted(source.iterdir()):
        if child.name in SKIP_NAMES or child.name.startswith(".env"):
            continue
        if child.is_symlink():
            raise ValueError("发行包不允许符号链接：" + str(child))
        target = destination / child.name
        if child.is_dir():
            copy_tree(child, target)
        elif child.is_file():
            shutil.copy2(child, target)
        else:
            raise ValueError("发行包只允许普通文件：" + str(child))


def files_under(directory):
    result = []
    for item in directory.rglob("*"):
        if item.is_symlink():
            raise ValueError("发行包不允许符号链接：" + str(item))
        if item.is_file() and item.relative_to(directory).as_posix() != SUM_FILE:
            result.append(item)
        elif not item.is_file() and not item.is_dir():
            raise ValueError("发行包包含非普通文件：" + str(item))
    return sorted(result)


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def verify_binary_platform(path, expected):
    """读取平台头，防止把其他架构程序装入本机平台目录。"""
    detected = set()
    with path.open("rb") as stream:
        header = stream.read(64)
        if header[:4] in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf") and len(header) >= 8:
            endian = "<" if header[:4] == b"\xcf\xfa\xed\xfe" else ">"
            cpu = struct.unpack(endian + "I", header[4:8])[0]
            detected.add({0x0100000c: "darwin-arm64", 0x01000007: "darwin-x64"}.get(cpu))
        elif header[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf") and len(header) >= 8:
            count = struct.unpack(">I", header[4:8])[0]
            if count > 64:
                raise ValueError("通用二进制架构数量异常")
            entry_size = 32 if header[:4] == b"\xca\xfe\xba\xbf" else 20
            stream.seek(8)
            for _ in range(count):
                entry = stream.read(entry_size)
                if len(entry) != entry_size:
                    break
                cpu = struct.unpack(">I", entry[:4])[0]
                detected.add({0x0100000c: "darwin-arm64", 0x01000007: "darwin-x64"}.get(cpu))
        elif header[:4] == b"\x7fELF" and len(header) >= 20 and header[4] == 2:
            endian = "<" if header[5] == 1 else ">"
            cpu = struct.unpack(endian + "H", header[18:20])[0]
            detected.add({183: "linux-arm64", 62: "linux-x64"}.get(cpu))
        elif header[:2] == b"MZ" and len(header) == 64:
            stream.seek(struct.unpack("<I", header[60:64])[0])
            pe = stream.read(6)
            if pe[:4] == b"PE\x00\x00" and len(pe) == 6:
                detected.add({0xaa64: "win32-arm64", 0x8664: "win32-x64"}.get(struct.unpack("<H", pe[4:6])[0]))
    if expected not in detected:
        raise ValueError("程序平台与发行目录不匹配或格式无法识别：" + expected)


def checksums(directory):
    return "".join(digest(path) + "  " + path.relative_to(directory).as_posix() + "\n" for path in files_under(directory))


def verify_package(directory):
    manifest = manifest_at(directory)
    checksum_path = directory / SUM_FILE
    if checksum_path.is_symlink() or not checksum_path.is_file() or checksum_path.read_text(encoding="utf-8") != checksums(directory):
        raise ValueError("发行包校验失败，文件有缺失、变更或额外文件：" + str(directory))
    for required in ("ui/index.html", "README.md", "Cargo.toml", "Cargo.lock"):
        if not (directory / required).is_file():
            raise ValueError("发行包缺少文件：" + required)
    if not (directory / "resources").is_dir() or not (directory / "src").is_dir():
        raise ValueError("发行包缺少资源或 Rust 源码")
    binaries = list((directory / "bin").glob("*/" + PLUGIN_ID))
    binaries += list((directory / "bin").glob("*/" + PLUGIN_ID + ".exe"))
    if not binaries or any(not p.stat().st_size or not p.stat().st_mode & stat.S_IXUSR for p in binaries):
        raise ValueError("发行包缺少非空且可执行的程序")
    for binary in binaries:
        verify_binary_platform(binary, binary.parent.name)
    return manifest


def replace_directory(staged, destination):
    """同文件系统落位；失败恢复旧目录，未知目录绝不覆盖。"""
    if destination.is_symlink():
        raise ValueError("拒绝替换符号链接目录：" + str(destination))
    backup = destination.with_name("." + destination.name + ".previous-" + uuid.uuid4().hex)
    if destination.exists():
        verify_package(destination)
        destination.rename(backup)
    installed = False
    try:
        staged.rename(destination)
        installed = True
        verify_package(destination)
    except BaseException:
        if installed and destination.exists():
            shutil.rmtree(destination)
        if backup.exists():
            backup.rename(destination)
        raise
    else:
        if backup.exists():
            shutil.rmtree(backup)


def create_zip(directory, output):
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                # ZipFile.write 保留 Unix 执行位；顶层目录等于清单 id。
                archive.write(path, PLUGIN_ID + "/" + path.relative_to(directory).as_posix())


def build(source, output=None, binary=None):
    source = Path(source).resolve()
    manifest = manifest_at(source)
    output = Path(output or main_project(source) / "dist" / PLUGIN_ID).absolute()
    if output.name != PLUGIN_ID or ".multicc-worktrees" in output.resolve().parts or ".git" in output.resolve().parts:
        raise ValueError("发行目录必须以插件标识命名，且不能放在临时工作区或 .git 中")
    platform_name = host_platform()
    binary_name = PLUGIN_ID + (".exe" if platform_name.startswith("win32-") else "")
    if binary is None:
        subprocess.run(["cargo", "build", "--locked", "--release", "--target-dir=" + str(TARGET_DIR)], cwd=source, check=True)
        binary = TARGET_DIR / "release" / binary_name
    binary = Path(binary).absolute()
    if binary.is_symlink() or not binary.is_file() or not binary.stat().st_size:
        raise ValueError("预编译程序必须是本机架构的非空普通文件")
    verify_binary_platform(binary, platform_name)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".creator-package-", dir=output.parent) as temporary:
        stage = Path(temporary) / PLUGIN_ID
        stage.mkdir()
        for name in ("plugin.json", "Cargo.toml", "Cargo.lock"):
            item = source / name
            if item.is_symlink() or not item.is_file():
                raise ValueError("源码缺少普通文件：" + name)
            shutil.copy2(item, stage / name)
        readme = source / "PLUGIN_README.md"
        if not readme.is_file() or readme.is_symlink():
            raise ValueError("缺少发行专用 PLUGIN_README.md，避免误带开发机器信息")
        shutil.copy2(readme, stage / "README.md")
        for name in ("ui", "resources", "src"):
            copy_tree(source / name, stage / name)
        program = stage / "bin" / platform_name / binary_name
        program.parent.mkdir(parents=True)
        shutil.copyfile(binary, program)
        program.chmod(0o755)
        (stage / SUM_FILE).write_text(checksums(stage), encoding="utf-8")
        verify_package(stage)
        archive_name = PLUGIN_ID + "-" + manifest["version"] + "-" + platform_name + ".zip"
        archive = Path(temporary) / archive_name
        create_zip(stage, archive)
        replace_directory(stage, output)
        archive.replace(output.parent / archive_name)
    return output, output.parent / archive_name


def install_debug(package, plugin_root):
    package = Path(package).absolute()
    plugin_root = Path(plugin_root)
    if not plugin_root.is_absolute() or plugin_root.name == PLUGIN_ID:
        raise ValueError("--plugin-root 必须是插件根目录的绝对路径，不是某个插件目录")
    if not plugin_root.is_dir() or plugin_root.is_symlink():
        raise ValueError("插件根目录必须已存在且不能是符号链接")
    verify_package(package)
    destination = plugin_root / PLUGIN_ID
    if package.resolve() == destination.resolve():
        raise ValueError("来源目录和目标目录相同")
    with tempfile.TemporaryDirectory(prefix=".creator-install-", dir=plugin_root) as temporary:
        stage = Path(temporary) / PLUGIN_ID
        shutil.copytree(package, stage, symlinks=True)
        verify_package(stage)
        replace_directory(stage, destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    builder = commands.add_parser("build", help="构建完整目录与 ZIP，不启动插件")
    builder.add_argument("--source", type=Path, default=Path(__file__).resolve().parent.parent)
    builder.add_argument("--output", type=Path, help="完整发行目录，默认主项目根目录下 dist/插件标识")
    builder.add_argument("--binary", type=Path, help="显式使用本机平台的预编译程序；默认执行 Cargo 构建")
    builder.add_argument("--copy-to", type=Path, help="构建后复制到已存在的宿主插件根目录")
    installer = commands.add_parser("install-debug", help="校验并复制现有发行目录，不执行插件")
    installer.add_argument("--package", required=True, type=Path)
    installer.add_argument("--plugin-root", required=True, type=Path)
    verifier = commands.add_parser("verify", help="核验完整发行目录及校验和")
    verifier.add_argument("--package", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "build":
            directory, archive = build(args.source, args.output, args.binary)
            print("发行目录：" + str(directory))
            print("安装压缩包：" + str(archive))
            print("压缩包 SHA256：" + digest(archive))
            if args.copy_to:
                print("调试副本：" + str(install_debug(directory, args.copy_to)))
        elif args.command == "install-debug":
            print("调试副本：" + str(install_debug(args.package, args.plugin_root)))
        else:
            verify_package(args.package)
            print("发行包校验通过")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("操作失败：" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
