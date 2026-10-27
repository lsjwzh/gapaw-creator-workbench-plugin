"""真实 Python HTTP → Rust 固定命令 → 合成旧 SQLite → 候选读回。"""
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
BUNDLE = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get("GAPAW_OUTREACH_SOURCE", "/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach"))
BINARY = Path(os.environ.get("GAPAW_TEST_BINARY", "/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench")).resolve()
LEGACY = ("creators", "drafts", "events", "audit", "meta", "messages", "negotiations")


def synthetic_report():
    def candidate(identity, ad_spend):
        return {"platform": "tiktok", "creatorId": identity, "handle": "synthetic_same_handle", "profileUrl": "https://www.tiktok.com/@synthetic_same_handle", "reason": "仅合成资料，不证明身份相同", "sources": [{"url": "https://kalodata.com/creator/synthetic", "capturedAt": "2026-10-01T00:00:00Z", "note": "合成测试"}], "missingFields": [], "videos": [{"videoId": identity + "-video", "url": "https://www.tiktok.com/@synthetic/video/" + identity, "publishedAt": "2026-10-01T00:00:00Z", "contributionRate": "0.3", "sales": [{"kind": "total", "gmv": "10", "commissionRate": "0.1"}], "adSpend": ad_spend, "fixedFee": "0", "sampleCost": "0"}]}
    return {"schemaVersion": 1, "methodVersion": "roi-selection-v1", "generatedAt": "2026-10-02T00:00:00Z", "period": {"start": "2026-10-01", "end": "2026-10-01", "timeZone": "UTC"}, "currency": "USD", "coverage": "仅合成样本，未核验全量", "missingFields": [], "candidates": [candidate("synthetic-known", "1"), candidate("synthetic-unknown", None)]}


class ProviderIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BINARY.is_file():
            raise RuntimeError("请先构建含 workbench-provider 的真实 Rust 程序")
        cls.temporary = tempfile.TemporaryDirectory(prefix="gapaw-provider-", dir="/tmp")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name).resolve()
        cls.workspace = Path(tempfile.mkdtemp(prefix=".gapaw-provider-test-", dir=Path.home())).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.workspace, True)
        cls.runtime = cls.root / "runtime"
        subprocess.run([sys.executable, "-B", str(BUNDLE / "build-patched.py"), str(SOURCE), "--output", str(cls.runtime)], check=True, capture_output=True)
        cls.token = secrets.token_urlsafe(48)
        cls.environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "GAPAW_WORKBENCH_ADOPTION_TOKEN": cls.token, "GAPAW_WORKBENCH_EXECUTABLE": str(BINARY), "GAPAW_CREATOR_DATA_DIR": str(cls.root / "plugin-state"), "GAPAW_CHROME_PLUGIN_DIR": str(cls.root / "unused-source"), "GAPAW_CHROME_DATA_DIR": str(cls.root / "unused-chrome")}
        cls.environment.pop("MULTICC_PLUGIN_WORKSPACE", None)
        cls.environment.pop("MULTICC_PLUGIN_DIR_ID", None)
        def run(command, data):
            output = subprocess.run([str(BINARY), command], input=json.dumps(data), text=True, capture_output=True, env=cls.environment, check=True, timeout=10)
            value = json.loads(output.stdout)
            if not value.get("ok"):
                raise RuntimeError("合成插件准备失败：" + str(value.get("error")))
            return value["data"]
        run("configure", {"workspace": {"dirId": "fixture-business-dir", "path": str(cls.workspace)}})
        operation = run("prepare-operation", {"requestId": "fixture-business-operation", "prompt": "只使用合成资料保存待核验候选", "runtime": {"cli": "codex"}})["operation"]
        cls.owner = {"operationId": operation["id"], "taskId": "fixture-business-task"}
        run("record-dispatch", {"operationId": operation["id"], "stage": "created", "response": {"taskId": cls.owner["taskId"], "sessionId": "fixture-business-session", "shellId": "fixture-business-shell", "url": "/air?task=fixture-business-task"}})
        run("record-dispatch", {"operationId": operation["id"], "stage": "sent", "response": {"taskId": cls.owner["taskId"], "receiptId": "fixture-business-receipt"}})
        cls.report = synthetic_report()
        saved = run("submit-result", {**cls.owner, "resultId": "fixture-business-result", "expectedRevision": 0, "report": cls.report})
        cls.computed = saved["record"]["computed"] if "record" in saved else saved["computed"]
        template = run("observation-contract", cls.owner)["templates"][0]["submissionTemplate"]
        cls.observation = run("preview-observation", template)["snapshot"]
        sys.path.insert(0, str(cls.runtime))
        cls.addClassCleanup(sys.path.remove, str(cls.runtime))
        from store import Store
        cls.Store = Store

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
        self.case = Path(self.temp.name)
        self.db = self.case / "outreach.sqlite3"
        profile = {"id": "LEGACY001", "handle": "synthetic_same_handle", "rank": 1, "priority": "合成", "followers": None, "affiliate_gmv_usd": None, "pet_gmv_share_pct": None, "topic": "合成旧档案", "history": "合成旧记录", "prior_invite": False, "kalodata_window": "unknown", "anchor1": "", "anchor2": "", "warnings": [], "products": []}
        self.Store(self.db).init({"source_sha256": "synthetic-only", "records": [{"profile": profile, "drafts": [{"channel": channel, "subject": "合成草稿", "body": "合成正文【固定费】"} for channel in ("comment", "dm", "email", "affiliate", "followup")]}]})
        self.environment = {**self.__class__.environment, "GAPAW_WORKBENCH_DB": str(self.db)}
        self.servers = []

    def tearDown(self):
        for process in self.servers:
            process.terminate()
            process.wait(timeout=3)
            process.stdout.close()
            errors = process.stderr.read()
            process.stderr.close()
            self.assertFalse(self.token in errors)
            self.assertFalse(errors, errors)
        self.temp.cleanup()

    def provider(self, action, payload=None, environment=None):
        response = subprocess.run([str(BINARY), "workbench-provider"], input=json.dumps({"action": action, "authorization": "Bearer " + self.token, "payload": payload or {}}), text=True, capture_output=True, env=environment or self.environment, timeout=10)
        self.assertEqual(response.returncode, 0)
        self.assertFalse(self.token in response.stdout + response.stderr)
        return json.loads(response.stdout)

    def initialize(self):
        result = self.provider("initialize")
        self.assertTrue(result["ok"], result)
        return result["data"]["businessStoreId"]

    def payload(self, store_id):
        return {"schemaVersion": 1, "adoptionId": "fixture-adoption", "expectedStoreId": store_id, **self.owner, "resultId": "fixture-business-result", "resultRevision": 1, "report": copy.deepcopy(self.report), "computed": copy.deepcopy(self.computed), "observations": [copy.deepcopy(self.observation)]}

    def start(self, environment=None):
        script = "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from server import make_handler;from store import Store;from http.server import ThreadingHTTPServer;s=ThreadingHTTPServer(('127.0.0.1',0),make_handler(Store(sys.argv[2]),Path(sys.argv[1])));print(s.server_port,flush=True);s.serve_forever()"
        process = subprocess.Popen([sys.executable, "-B", "-u", "-c", script, str(self.runtime), str(self.db)], env=environment or self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.servers.append(process)
        self.assertTrue(select.select([process.stdout], [], [], 3)[0], "合成 HTTP 服务未及时启动")
        return "http://127.0.0.1:" + process.stdout.readline().strip()

    def request(self, base, action, payload=None, token=True):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + (self.token if token is True else token)
        request = urllib.request.Request(base + "/api/plugin-selection", json.dumps({"action": action, "payload": payload or {}}).encode(), headers)
        try:
            response = urllib.request.urlopen(request, timeout=12)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            value = response.read().decode()
            self.assertFalse(self.token in value)
            return response.status, json.loads(value)

    def legacy_bytes(self):
        with sqlite3.connect(self.db) as connection:
            values = [(name, connection.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone()[0], connection.execute("SELECT * FROM " + name + " ORDER BY rowid").fetchall()) for name in LEGACY]
        return json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()

    def counts(self):
        with sqlite3.connect(self.db) as connection:
            return {name: connection.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in ("gapaw_selection_batches", "gapaw_selection_candidates", "gapaw_selection_observations", "gapaw_selection_receipts", "gapaw_selection_audit")}

    def test_http_authentication_and_explicit_initialization(self):
        base = self.start()
        before = self.legacy_bytes()
        self.assertEqual(self.request(base, "status", token=False)[0], 401)
        self.assertEqual(self.request(base, "status", token="synthetic-wrong-token")[0], 401)
        status, value = self.request(base, "status")
        self.assertEqual(status, 200)
        self.assertFalse(value["data"]["ready"])
        self.assertEqual(self.request(base, "initialize")[0], 400)
        self.assertFalse(self.request(base, "adopt", self.payload("not-initialized"))[1]["ok"])
        self.assertEqual(before, self.legacy_bytes())
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE 'gapaw_selection_%'").fetchone()[0], 0)

    def test_http_end_to_end_preserves_unknown_and_old_rows(self):
        before = self.legacy_bytes()
        store_id = self.initialize()
        base = self.start({**self.environment, "GAPAW_WORKBENCH_DB": str(self.case / "untrusted-env.sqlite")})
        payload = self.payload(store_id)
        before_preview = self.counts()
        status, preview = self.request(base, "preview", payload)
        self.assertEqual(status, 200, preview)
        self.assertEqual(preview["data"]["candidateCount"], 2)
        self.assertEqual(len(preview["data"]["handleConflicts"]), 2)
        self.assertEqual(before_preview, self.counts())
        status, adopted = self.request(base, "adopt", payload)
        self.assertEqual(status, 200, adopted)
        receipt = adopted["data"]["receipt"]
        self.assertEqual(receipt["payloadHash"], preview["data"]["payloadHash"])
        self.assertEqual(receipt["status"], "candidate_pending_verification")
        self.assertEqual(len(set(receipt["candidateIds"])), 2)
        unknown = adopted["data"]["candidates"][1]
        self.assertEqual(unknown["verification"], "unverified")
        self.assertIsNone(unknown["computed"]["summary"]["breakEvenRate"])
        self.assertEqual(before, self.legacy_bytes())
        self.assertFalse((self.case / "untrusted-env.sqlite").exists())
        self.assertFalse(self.token.encode() in self.db.read_bytes())
        read = self.request(base, "receipt", {"adoptionId": payload["adoptionId"]})[1]["data"]
        self.assertEqual(read["receipt"], receipt)
        self.assertEqual(read["candidates"], adopted["data"]["candidates"])
        listing = self.request(base, "list", {"limit": 1})[1]["data"]
        self.assertEqual(listing["items"][0]["batchId"], receipt["batchId"])
        batch = self.request(base, "batch", {"batchId": receipt["batchId"], "limit": 1})[1]["data"]
        self.assertEqual((len(batch["candidates"]), batch["total"], batch["nextOffset"]), (1, 2, 1))
        page2 = self.request(base, "batch", {"batchId": receipt["batchId"], "offset": 1, "limit": 1})[1]["data"]
        self.assertEqual(page2["candidates"][0]["candidateId"], receipt["candidateIds"][1])
        with urllib.request.urlopen(base + "/api/creators", timeout=3) as response:
            self.assertEqual(len(json.load(response)["items"]), 1)
        with urllib.request.urlopen(base + "/", timeout=3) as response:
            self.assertIn(b"/plugins/gapaw-creator-workbench/ui/candidates.html", response.read())

    def test_idempotent_replay_and_payload_conflict(self):
        payload = self.payload(self.initialize())
        base = self.start()
        first = self.request(base, "adopt", payload)[1]["data"]
        count = self.counts()
        replay = self.request(base, "adopt", payload)[1]["data"]
        self.assertTrue(replay["replayed"])
        self.assertEqual(first["receipt"], replay["receipt"])
        payload["report"]["coverage"] = "不同声明"
        self.assertFalse(self.request(base, "adopt", payload)[1]["ok"])
        payload = self.payload(first["receipt"]["businessStoreId"])
        payload["adoptionId"] = "another-adoption"
        self.assertFalse(self.request(base, "adopt", payload)[1]["ok"])
        self.assertEqual(count, self.counts())
        self.assertFalse(self.request(base, "receipt", {"adoptionId": "absent"})[1]["data"]["found"])

    def test_duplicate_observation_rolls_back_entire_batch(self):
        payload = self.payload(self.initialize())
        payload["observations"].append(copy.deepcopy(payload["observations"][0]))
        before = self.legacy_bytes()
        result = self.request(self.start(), "adopt", payload)[1]
        self.assertFalse(result["ok"])
        self.assertIn("事务已回滚", result["error"])
        self.assertTrue(all(count == 0 for count in self.counts().values()))
        self.assertEqual(before, self.legacy_bytes())

    def test_store_task_computed_and_empty_report_rejected(self):
        payload = self.payload(self.initialize())
        base = self.start()
        variants = []
        wrong = copy.deepcopy(payload); wrong["expectedStoreId"] = "another-store"; variants.append(wrong)
        wrong = copy.deepcopy(payload); wrong["observations"][0]["taskId"] = "another-task"; variants.append(wrong)
        wrong = copy.deepcopy(payload); wrong["computed"]["candidates"][0]["summary"]["breakEvenRate"] = "0"; variants.append(wrong)
        wrong = copy.deepcopy(payload); wrong["report"]["candidates"] = []; wrong["computed"]["candidates"] = []; variants.append(wrong)
        wrong = copy.deepcopy(payload); wrong["dbPath"] = str(self.db); variants.append(wrong)
        for value in variants:
            with self.subTest(case=variants.index(value)):
                self.assertFalse(self.request(base, "adopt", value)[1]["ok"])
        self.assertTrue(all(count == 0 for count in self.counts().values()))

    def test_legacy_report_without_observations_stays_unverified(self):
        payload = self.payload(self.initialize()); payload["observations"] = []
        result = self.request(self.start(), "adopt", payload)[1]
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["batch"]["observationCount"], 0)
        self.assertTrue(all(item["verification"] == "unverified" for item in result["data"]["candidates"]))

    def test_unknown_schema_symlink_worktree_and_missing_config_rejected(self):
        environment = dict(self.environment); environment.pop("GAPAW_WORKBENCH_ADOPTION_TOKEN")
        self.assertFalse(self.provider("status", environment=environment)["ok"])
        link = self.case / "linked.sqlite"; link.symlink_to(self.db)
        self.assertFalse(self.provider("status", environment={**self.environment, "GAPAW_WORKBENCH_DB": str(link)})["ok"])
        worktree = self.case / ".multicc-worktrees" / "synthetic"; worktree.mkdir(parents=True)
        copied = worktree / "copy.sqlite"; shutil.copy2(self.db, copied)
        self.assertFalse(self.provider("status", environment={**self.environment, "GAPAW_WORKBENCH_DB": str(copied)})["ok"])
        with sqlite3.connect(self.db) as connection:
            connection.execute("CREATE TABLE unexpected(value TEXT)")
        self.assertFalse(self.provider("initialize")["ok"])

    def test_source_whitelist_and_original_checksums(self):
        expected = json.loads((BUNDLE / "source-checksums.json").read_text())
        self.assertEqual(set(path.name for path in self.runtime.iterdir()), set(expected) | {"workbench_bridge.py"})
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256((SOURCE / name).read_bytes()).hexdigest(), digest)

    def test_partial_http_body_has_total_deadline_and_short_read_is_rejected(self):
        port = int(self.start().rsplit(":", 1)[1])
        request = ("POST /api/plugin-selection HTTP/1.0\r\nContent-Length: 100\r\nAuthorization: Bearer " + self.token + "\r\n\r\n{").encode()
        with socket.create_connection(("127.0.0.1", port), timeout=5) as client:
            start = time.monotonic()
            client.sendall(request)
            response = client.makefile("rb").read()
            self.assertTrue(response.startswith(b"HTTP/1.0 504"), repr(response.split(b"\r\n")[0]))
            self.assertLess(time.monotonic() - start, 5)
            self.assertFalse(self.token.encode() in response)
        with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
            client.sendall(request)
            client.shutdown(socket.SHUT_WR)
            self.assertTrue(client.makefile("rb").read().startswith(b"HTTP/1.0 400"))

    def test_subprocess_timeout_and_output_limit_reap_child(self):
        for name, body, expected_status in [
            ("oversized", "sys.stdout.buffer.write(b'x' * (3 * 1024 * 1024));sys.stdout.flush()", 400),
            ("slow", "time.sleep(30)", 504),
        ]:
            with self.subTest(mode=name):
                executable = self.case / name
                marker = self.case / (name + ".pid")
                executable.write_text("#!" + sys.executable + "\nimport os,sys,time\nfrom pathlib import Path\nPath(" + repr(str(marker)) + ").write_text(str(os.getpid()))\n" + body + "\n")
                executable.chmod(0o700)
                base = self.start({**self.environment, "GAPAW_WORKBENCH_EXECUTABLE": str(executable)})
                start = time.monotonic()
                self.assertEqual(self.request(base, "status")[0], expected_status)
                self.assertLess(time.monotonic() - start, 12)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(marker.read_text()), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
