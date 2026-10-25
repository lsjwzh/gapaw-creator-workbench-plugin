"""发行工具边界测试；所有临时文件均位于系统临时目录。"""

import importlib.util
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location("package_plugin", Path(__file__).resolve().parents[1] / "scripts/package_plugin.py")
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="creator-package-test-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        fixtures = {
            "plugin.json": json.dumps({"schema": 1, "id": PACKAGE.PLUGIN_ID, "version": "0.1.0", "ui": "ui/index.html"}),
            "Cargo.toml": '[package]\nname = "gapaw-creator-workbench"\nversion = "0.1.0"\n',
            "Cargo.lock": "version = 4\n",
            "PLUGIN_README.md": "# 达人工作台插件\n",
            "README.md": "开发机器信息，不进入发行包",
            "src/main.rs": "fn main() {}\n",
            "ui/index.html": "<!doctype html><title>达人工作台</title>",
            "resources/prompt.txt": "按回本率选人",
            "integrations/chrome-read-bridge/README.md": "仅在隔离副本应用升级",
            "integrations/chrome-read-bridge/read_bridge.rs": "// 配套桥接源码\n",
            "integrations/chrome-read-bridge/data/private.json": "不得发行",
            "requirements/private.txt": "不得发行",
            "data/private.json": "不得发行",
            "docs/private.md": "不得发行",
            "ui/.env": "不得发行",
            "ui/data/private.json": "不得发行",
            "target/private": "不得发行",
            ".git/config": "不得发行",
        }
        for name, content in fixtures.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        self.binary = self.root / "fixture-binary"
        host = PACKAGE.host_platform()
        if host.startswith("darwin-"):
            self.binary.write_bytes(b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x0100000c if host.endswith("arm64") else 0x01000007) + bytes(56))
        elif host.startswith("linux-"):
            self.binary.write_bytes(b"\x7fELF\x02\x01" + bytes(12) + struct.pack("<H", 183 if host.endswith("arm64") else 62) + bytes(44))
        else:
            self.binary.write_bytes(b"MZ" + bytes(58) + struct.pack("<I", 64) + b"PE\x00\x00" + struct.pack("<H", 0xaa64 if host.endswith("arm64") else 0x8664))
        self.output = self.root / "dist" / PACKAGE.PLUGIN_ID
        self.plugins = self.root / "plugins"
        self.plugins.mkdir()

    def build(self):
        return PACKAGE.build(self.source, self.output, self.binary)

    def test_package_boundary_zip_permissions_and_hashes(self):
        directory, archive = self.build()
        PACKAGE.verify_package(directory)
        self.assertEqual((directory / "README.md").read_text(), "# 达人工作台插件\n")
        self.assertFalse((directory / "requirements").exists())
        self.assertFalse((directory / "ui/.env").exists())
        self.assertFalse((directory / "ui/data").exists())
        self.assertTrue((directory / "integrations/chrome-read-bridge/read_bridge.rs").is_file())
        self.assertFalse((directory / "integrations/chrome-read-bridge/data").exists())
        binary_relative = "bin/" + PACKAGE.host_platform() + "/" + PACKAGE.PLUGIN_ID
        self.assertTrue((directory / binary_relative).stat().st_mode & stat.S_IXUSR)
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.testzip(), None)
            info = zipped.getinfo(PACKAGE.PLUGIN_ID + "/" + binary_relative)
            self.assertTrue((info.external_attr >> 16) & stat.S_IXUSR)
            self.assertNotIn(PACKAGE.PLUGIN_ID + "/data/private.json", zipped.namelist())
            self.assertEqual(zipped.read(PACKAGE.PLUGIN_ID + "/README.md"), (directory / "README.md").read_bytes())

    def test_copy_and_repeat_build_retain_complete_package(self):
        self.build()
        target = PACKAGE.install_debug(self.output, self.plugins)
        self.assertEqual(PACKAGE.checksums(target), PACKAGE.checksums(self.output))
        (self.source / "ui/index.html").write_text("新版工作台")
        self.build()
        PACKAGE.install_debug(self.output, self.plugins)
        self.assertEqual((target / "ui/index.html").read_text(), "新版工作台")
        self.assertEqual(list(self.plugins.glob(".*")), [])

    def test_refuse_unknown_destination_without_losing_files(self):
        self.build()
        target = self.plugins / PACKAGE.PLUGIN_ID
        target.mkdir()
        (target / "keep.txt").write_text("原文件")
        with self.assertRaises(ValueError):
            PACKAGE.install_debug(self.output, self.plugins)
        self.assertEqual((target / "keep.txt").read_text(), "原文件")

    def test_refuse_modified_package_before_touching_target(self):
        self.build()
        target = PACKAGE.install_debug(self.output, self.plugins)
        before = PACKAGE.checksums(target)
        (self.output / "ui/index.html").write_text("被修改")
        with self.assertRaises(ValueError):
            PACKAGE.install_debug(self.output, self.plugins)
        self.assertEqual(PACKAGE.checksums(target), before)

    def test_refuse_symlink_in_source(self):
        (self.source / "resources/link").symlink_to(self.binary)
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_failed_landing_restores_existing_package(self):
        self.build()
        target = PACKAGE.install_debug(self.output, self.plugins)
        before = PACKAGE.checksums(target)
        original_verify = PACKAGE.verify_package
        def fail_only_new_landing(directory):
            if directory == target and list(self.plugins.glob(".*.previous-*")):
                raise ValueError("模拟落位后校验失败")
            return original_verify(directory)
        with patch.object(PACKAGE, "verify_package", side_effect=fail_only_new_landing):
            with self.assertRaises(ValueError):
                PACKAGE.install_debug(self.output, self.plugins)
        self.assertEqual(PACKAGE.checksums(target), before)
        PACKAGE.verify_package(target)

    def test_reject_worktree_output_and_ambiguous_plugin_root(self):
        bad = self.root / ".multicc-worktrees" / "task" / PACKAGE.PLUGIN_ID
        with self.assertRaises(ValueError):
            PACKAGE.build(self.source, bad, self.binary)
        self.build()
        with self.assertRaises(ValueError):
            PACKAGE.install_debug(self.output, "plugins")
        with self.assertRaises(ValueError):
            PACKAGE.install_debug(self.output, self.plugins / PACKAGE.PLUGIN_ID)

    def test_default_cargo_command_is_locked_and_outside_worktree(self):
        with patch.object(PACKAGE.subprocess, "run", side_effect=RuntimeError("停止在编译命令")) as run:
            with self.assertRaises(RuntimeError):
                PACKAGE.build(self.source, self.output)
            self.assertEqual(run.call_args.args[0], ["cargo", "build", "--locked", "--release", "--target-dir=/tmp/gapaw-creator-plugin-target"])

    def test_refuse_other_platform_binary(self):
        other = "linux-arm64" if PACKAGE.host_platform().startswith("darwin-") else "darwin-arm64"
        with self.assertRaises(ValueError):
            PACKAGE.verify_binary_platform(self.binary, other)


if __name__ == "__main__":
    unittest.main(verbosity=2)
