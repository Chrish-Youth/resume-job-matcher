import json
import re
import shutil
import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import app

_test_store_dir = app.ROOT / "tmp" / "zhide-test-store"
_test_store_dir.mkdir(parents=True, exist_ok=True)
app.DATA_DIR = _test_store_dir
app.RADAR_STORE_PATH = _test_store_dir / "radar_store.json"
app._load_radar_store()


def tearDownModule():
    shutil.rmtree(_test_store_dir, ignore_errors=True)


def make_job(index: int, **overrides):
    job = {
        "id": f"job-{index}",
        "title": f"环境工程师 {index}",
        "company": f"测试企业 {index}",
        "location": "上海 · 浦东新区",
        "salary": "8-12K",
        "education": "本科",
        "experience": "经验不限",
        "fresh": True,
        "logo": "TEST",
        "logoColor": "#17633f",
        "tags": ["环境监测", "数据分析"],
        "description": "负责环境监测、数据整理与报告编制。",
        "detailStatus": "detail",
        "highlights": [],
        "posted": "今天",
    }
    job.update(overrides)
    return job


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.profile = {
            "name": "测试用户",
            "filename": "resume.pdf",
            "preview": "包含个人电话和邮箱的简历预览",
            "education": "本科",
            "school": "测试大学",
            "target": "环境工程方向",
            "city": "上海",
            "searchKeyword": "环境工程",
            "skills": ["环境监测", "数据分析"],
            "experienceCount": 2,
            "highlights": ["有环境监测项目经验"],
        }

    def test_compact_profile_does_not_repeat_resume_preview(self):
        compact = app.compact_profile_for_llm(self.profile)
        self.assertNotIn("preview", compact)
        self.assertNotIn("filename", compact)
        self.assertNotIn("name", compact)
        self.assertEqual(compact["target"], "环境工程方向")

    def test_local_score_includes_grade_reasons_and_gaps(self):
        result = app.score_job(self.profile, make_job(1, tags=["环境监测", "ArcGIS"]))
        self.assertIn(result["fitGrade"], {"A", "B", "C", "D"})
        self.assertTrue(result["reasons"])
        self.assertEqual(result["gaps"], ["ArcGIS"])
        self.assertEqual(result["matchEngine"], "local")

    def test_list_only_job_cannot_receive_grade_a(self):
        result = app.score_job(self.profile, make_job(1, detailStatus="list"))
        self.assertLessEqual(result["score"], 85)
        self.assertNotEqual(result["fitGrade"], "A")
        self.assertEqual(result["evidenceLevel"], "limited")

    def test_feedback_changes_similar_job_score(self):
        positive = {
            **self.profile,
            "feedback": [{
                "status": "saved", "title": "环境工程师", "company": "旧公司",
                "tags": ["环境监测", "数据分析"],
            }],
        }
        detailed_job = make_job(1, title="环境工程师", description="环境监测、数据分析与报告编制。" * 20)
        baseline = app.score_job(self.profile, detailed_job)
        learned = app.score_job(positive, detailed_job)
        self.assertGreater(learned["score"], baseline["score"])
        self.assertTrue(any("感兴趣" in reason for reason in learned["reasons"]))

    def test_llm_matching_scores_every_batch(self):
        jobs = [make_job(index) for index in range(45)]

        def fake_call(_provider, messages, **_kwargs):
            ids = re.findall(r'"id":\s*"(job-\d+)"', messages[-1]["content"])
            return json.dumps({
                "matches": [
                    {
                        "jobId": job_id,
                        "score": 82,
                        "matchedTags": ["环境监测"],
                        "reasons": ["岗位方向与环境监测经历一致"],
                        "gaps": ["报告编制"],
                    }
                    for job_id in ids
                ]
            }, ensure_ascii=False)

        with patch.object(app, "call_llm", side_effect=fake_call) as mocked:
            results, warning = app.llm_match_jobs(self.profile, jobs, "qwen")

        self.assertEqual(mocked.call_count, 3)
        self.assertEqual(len(results), 45)
        self.assertIsNone(warning)
        self.assertTrue(all(job["matchEngine"] == "ai" for job in results))
        self.assertTrue(all(job["fitGrade"] == "B" for job in results))

    def test_search_plan_expands_three_relevance_tiers(self):
        plan = app.generate_search_plan(self.profile, None, ["zhaopin", "boss"])
        tiers = {group["tier"] for group in plan["groups"]}
        self.assertEqual(tiers, {"exact", "adjacent", "transferable"})
        self.assertGreaterEqual(len(plan["tasks"]), 10)
        self.assertTrue(any(task["platform"] == "zhaopin" for task in plan["tasks"]))
        self.assertTrue(any(task["platform"] == "boss" for task in plan["tasks"]))
        self.assertTrue(all("上海" in task["city"] for task in plan["tasks"]))

    def test_search_plan_rejects_llm_queries_that_drift_from_profile(self):
        profile = {
            **self.profile,
            "target": "数据运营方向",
            "searchKeyword": "数据运营",
            "skills": ["Excel", "数据分析", "用户运营"],
        }
        bad_response = json.dumps({
            "groups": [
                {"tier": "exact", "queries": ["行政助理", "文员", "数据录入员"]},
                {"tier": "adjacent", "queries": ["财务助理", "运营助理"]},
                {"tier": "transferable", "queries": ["客服专员", "档案管理员"]},
            ]
        }, ensure_ascii=False)

        with patch.object(app, "call_llm", return_value=bad_response):
            plan = app.generate_search_plan(profile, "qwen", ["zhaopin"])

        queries = [query for group in plan["groups"] for query in group["queries"]]
        self.assertIn("数据运营", queries)
        self.assertIn("运营助理", queries)
        self.assertNotIn("行政助理", queries)
        self.assertNotIn("数据录入员", queries)
        self.assertNotIn("客服专员", queries)
        self.assertIn("已自动校正", plan["warning"])

    def test_radar_only_sends_top_sixty_jobs_to_ai(self):
        jobs = [make_job(index, title=f"环境工程师 {index}") for index in range(80)]

        def fake_match(_profile, finalists, _provider):
            self.assertEqual(len(finalists), 60)
            return [{**job, "score": 88, "fitGrade": "A", "fitLabel": "高度匹配", "matchEngine": "ai"} for job in finalists], None

        with patch.object(app, "llm_match_jobs", side_effect=fake_match) as mocked:
            ranked, excluded, warning = app.finalize_radar_jobs(self.profile, jobs, "qwen")

        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(len(ranked), 80)
        self.assertEqual(excluded, 0)
        self.assertIsNone(warning)
        self.assertEqual(sum(job["matchEngine"] == "ai" for job in ranked), 60)


class PreferenceTests(unittest.TestCase):
    def test_salary_normalization(self):
        self.assertEqual(app.salary_midpoint_k("8-12K"), 10)
        self.assertAlmostEqual(app.salary_midpoint_k("200-300元/天"), 5.4375)
        self.assertAlmostEqual(app.salary_midpoint_k("24-36万/年"), 25)
        self.assertIsNone(app.salary_midpoint_k("薪资面议"))

    def test_preferences_filter_before_matching(self):
        profile = {
            "city": "上海",
            "preferences": {"city": "上海", "minSalaryK": 8, "freshOnly": True},
        }
        jobs = [
            make_job(1),
            make_job(2, location="北京 · 海淀区"),
            make_job(3, salary="4-6K"),
            make_job(4, fresh=False),
            make_job(5, salary="薪资面议"),
        ]
        filtered, excluded = app.apply_job_preferences(profile, jobs)
        self.assertEqual([job["id"] for job in filtered], ["job-1", "job-5"])
        self.assertEqual(excluded, 3)


class ExtensionSessionTests(unittest.TestCase):
    def setUp(self):
        with app.EXTENSION_INBOX_LOCK:
            app.EXTENSION_SESSIONS.clear()
            app.ACTIVE_EXTENSION_SESSION = None

    def tearDown(self):
        with app.EXTENSION_INBOX_LOCK:
            app.EXTENSION_SESSIONS.clear()
            app.ACTIVE_EXTENSION_SESSION = None

    def test_batches_are_isolated_by_capture_session(self):
        first = "capture_aaaaaaaaaaaa"
        second = "capture_bbbbbbbbbbbb"

        app.activate_extension_session(first, "zhaopin")
        app.enqueue_extension_batch({"platform": "zhaopin", "jobs": [{"title": "岗位一"}]})
        app.activate_extension_session(second, "boss")
        app.enqueue_extension_batch({"platform": "boss", "jobs": [{"title": "岗位二"}]})

        first_sequence, first_batches = app.extension_batches_after(first, 0)
        second_sequence, second_batches = app.extension_batches_after(second, 0)

        self.assertEqual(first_sequence, 1)
        self.assertEqual(second_sequence, 1)
        self.assertEqual(first_batches[0]["jobs"][0]["title"], "岗位一")
        self.assertEqual(second_batches[0]["jobs"][0]["title"], "岗位二")
        self.assertNotEqual(first_batches[0]["sessionId"], second_batches[0]["sessionId"])

    def test_radar_advances_and_deduplicates_job_pool(self):
        session_id = "capture_radar123456"
        profile = {"city": "上海", "searchKeyword": "环境工程", "skills": ["环境监测"]}
        plan = app.generate_search_plan(profile, None, ["zhaopin"])
        radar = app.start_radar_session(session_id, plan)
        first_task = radar["currentTask"]
        duplicate = make_job(1)
        batch = {"jobs": [duplicate, dict(duplicate)]}

        updated = app.radar_record_batch(session_id, first_task["id"], batch)
        pool, _ = app.radar_job_pool(session_id)

        self.assertEqual(updated["completed"], 1)
        self.assertEqual(updated["collected"], 2)
        self.assertEqual(updated["unique"], 1)
        self.assertEqual(updated["duplicates"], 1)
        self.assertEqual(len(pool), 1)
        self.assertEqual(pool[0]["searchTier"], first_task["tier"])

    def test_blocked_pauses_and_resume_restarts_task(self):
        session_id = "capture_radarblocked"
        profile = {"city": "上海", "searchKeyword": "环境工程", "skills": ["环境监测"]}
        plan = app.generate_search_plan(profile, None, ["zhaopin"])
        radar = app.start_radar_session(session_id, plan)
        first_task = radar["currentTask"]

        blocked = app.block_radar_task(session_id, first_task["id"], "招聘网站弹出了安全验证")
        self.assertEqual(blocked["status"], "paused_blocked")
        self.assertFalse(blocked["active"])
        self.assertIn("安全验证", blocked["blockedReason"])

        resumed = app.resume_radar_session(session_id)
        self.assertEqual(resumed["status"], "running")
        self.assertTrue(resumed["active"])
        self.assertNotIn("blockedReason", resumed)
        self.assertEqual(resumed["currentTask"]["status"], "pending")

    def test_blocked_ignores_stale_task_id(self):
        session_id = "capture_radarstale"
        profile = {"city": "上海", "searchKeyword": "环境工程", "skills": ["环境监测"]}
        plan = app.generate_search_plan(profile, None, ["zhaopin"])
        app.start_radar_session(session_id, plan)

        result = app.block_radar_task(session_id, "radar-not-current", "过期任务")
        self.assertEqual(result["status"], "running")

    def test_radar_queues_and_records_detail_review(self):
        session_id = "capture_radardetail1"
        profile = {
            "city": "上海", "searchKeyword": "环境工程", "skills": ["环境监测"],
            "education": "本科",
        }
        plan = {
            "groups": [{"tier": "exact", "label": "精准岗位", "queries": ["环境工程"]}],
            "tasks": [{
                "id": "radar-search-one", "type": "search", "platform": "zhaopin",
                "platformLabel": "智联招聘", "tier": "exact", "tierLabel": "精准岗位",
                "query": "环境工程", "url": "https://sou.zhaopin.com/?kw=test", "status": "pending",
            }],
        }
        radar = app.start_radar_session(session_id, plan, profile)
        job = make_job(1, url="https://www.zhaopin.com/jobdetail/test-one.htm", detailStatus="list")
        updated = app.radar_record_batch(session_id, radar["currentTask"]["id"], {"jobs": [job]})
        self.assertEqual(updated["status"], "running")
        self.assertEqual(updated["currentTask"]["type"], "detail")
        self.assertEqual(updated["detailTotal"], 1)

        finished = app.radar_record_batch(session_id, updated["currentTask"]["id"], {
            "detail": {"description": "岗位职责与任职要求：" + "环境监测与报告编制。" * 12, "tags": ["报告编制"]},
            "jobs": [],
        })
        pool, _ = app.radar_job_pool(session_id)
        self.assertEqual(finished["status"], "ready")
        self.assertEqual(pool[0]["detailStatus"], "detail")
        self.assertIn("报告编制", pool[0]["tags"])


class PersistenceTests(unittest.TestCase):
    def test_store_retries_windows_replace_failure(self):
        real_replace = app.os.replace
        attempts = {"count": 0}

        def flaky_replace(source, destination):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise PermissionError("temporary scanner lock")
            return real_replace(source, destination)

        with patch.object(app.os, "replace", side_effect=flaky_replace), \
                patch.object(app.time, "sleep") as fake_sleep:
            self.assertTrue(app._save_radar_store())
        self.assertEqual(attempts["count"], 2)
        fake_sleep.assert_called_once()


class HostValidationTests(unittest.TestCase):
    def test_host_header_allowed(self):
        allowed = {
            "127.0.0.1:8765", "localhost:8765", "[::1]:8765",
            "127.0.0.1", "localhost", "  LOCALHOST:8765 ",
        }
        for host in allowed:
            self.assertTrue(app.host_header_allowed(host), host)

    def test_host_header_rejects_foreign_and_malformed(self):
        rejected = {
            "", "evil.example.com", "evil.example.com:8765",
            "127.0.0.1:9999", "127.0.0.2:8765", "example.com:80",
        }
        for host in rejected:
            self.assertFalse(app.host_header_allowed(host), host)


class LlmRetryTests(unittest.TestCase):
    def test_call_llm_rejects_truncated_response(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{
                        "message": {"content": "{\"matches\":["},
                        "finish_reason": "length",
                    }]
                }).encode("utf-8")

        with patch.object(app.urllib.request, "urlopen", return_value=FakeResponse()):
            with patch.dict(app.os.environ, {app.PROVIDERS["qwen"]["keyEnv"]: "test-key"}):
                with self.assertRaisesRegex(ValueError, "被截断"):
                    app.call_llm("qwen", [{"role": "user", "content": "unique-truncated-test"}])

    def test_call_llm_retries_transient_error_then_succeeds(self):
        calls = {"count": 0}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"choices":[{"message":{"content":"ok"}}]}'

        def fake_urlopen(_request, **_kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                raise urllib.error.HTTPError(
                    "https://example.test", 429, "Too Many Requests", {}, BytesIO(b"rate limited")
                )
            return FakeResponse()

        with patch.object(app.os, "getenv", return_value="test-key"), \
                patch.object(app.urllib.request, "urlopen", side_effect=fake_urlopen), \
                patch.object(app.time, "sleep") as fake_sleep:
            content = app.call_llm("qwen", [{"role": "user", "content": "hi"}])

        self.assertEqual(content, "ok")
        self.assertEqual(calls["count"], 2)
        self.assertEqual(fake_sleep.call_count, 1)

    def test_call_llm_does_not_retry_non_transient_error(self):
        calls = {"count": 0}

        def fake_urlopen(_request, **_kwargs):
            calls["count"] += 1
            raise urllib.error.HTTPError(
                "https://example.test", 400, "Bad Request", {}, BytesIO(b"bad")
            )

        with patch.object(app.os, "getenv", return_value="test-key"), \
                patch.object(app.urllib.request, "urlopen", side_effect=fake_urlopen), \
                patch.object(app.time, "sleep") as fake_sleep:
            with self.assertRaises(ValueError):
                app.call_llm("qwen", [{"role": "user", "content": "hi"}])

        self.assertEqual(calls["count"], 1)
        fake_sleep.assert_not_called()


class GreetingTests(unittest.TestCase):
    def setUp(self):
        self.profile = {
            "name": "测试用户",
            "filename": "resume.pdf",
            "education": "本科",
            "school": "测试大学",
            "target": "环境工程方向",
            "city": "上海",
            "searchKeyword": "环境工程",
            "skills": ["环境监测", "数据分析"],
            "experienceCount": 2,
            "highlights": ["有环境监测项目经验"],
        }

    def test_llm_generate_greetings_maps_job_ids(self):
        jobs = [make_job(1), make_job(2)]
        fake = json.dumps({
            "greetings": [
                {"jobId": "job-1", "text": "您好，我是张三。"},
                {"jobId": "job-2", "text": "您好，期待与您沟通。"},
            ]
        }, ensure_ascii=False)
        with patch.object(app, "call_llm", return_value=fake):
            result = app.llm_generate_greetings(self.profile, jobs, "professional", "qwen")
        self.assertEqual(result["job-1"], "您好，我是张三。")
        self.assertEqual(result["job-2"], "您好，期待与您沟通。")

    def test_local_greeting_variants_exist(self):
        job = make_job(1)
        for tone in ("professional", "direct", "warm"):
            greeting = app.generate_greeting(self.profile, job, tone)
            self.assertIn("环境工程师", greeting)
            self.assertLessEqual(len(greeting), 300)


class ScheduledRadarTests(unittest.TestCase):
    def setUp(self):
        with app.EXTENSION_INBOX_LOCK:
            app.EXTENSION_SESSIONS.clear()
            app.ACTIVE_EXTENSION_SESSION = None
            self._old_schedule = dict(app.SCHEDULE_CONFIG)
            self._old_last = dict(app.LAST_SCHEDULED)
            app.LAST_SCHEDULED.clear()
            app.LAST_SCHEDULED.update({
                "profile": None, "jobs": [], "ids": [], "engine": None, "summary": None,
            })

    def tearDown(self):
        with app.EXTENSION_INBOX_LOCK:
            app.EXTENSION_SESSIONS.clear()
            app.ACTIVE_EXTENSION_SESSION = None
            app.SCHEDULE_CONFIG.clear()
            app.SCHEDULE_CONFIG.update(self._old_schedule)
            app.LAST_SCHEDULED.clear()
            app.LAST_SCHEDULED.update(self._old_last)

    def _enable_schedule(self):
        with app.EXTENSION_INBOX_LOCK:
            app.SCHEDULE_CONFIG.update({
                "enabled": True,
                "hour": 9,
                "minute": 0,
                "platforms": ["zhaopin", "boss"],
                "profile": {
                    "city": "上海",
                    "searchKeyword": "环境工程",
                    "skills": ["环境监测"],
                },
                "provider": None,
            })

    def test_scheduled_start_creates_auto_finalize_session(self):
        self._enable_schedule()
        session_id, radar = app.start_scheduled_radar()
        self.assertTrue(session_id.startswith("sched_"))
        self.assertEqual(radar["status"], "running")
        self.assertTrue(radar["currentTask"]["url"])
        with app.EXTENSION_INBOX_LOCK:
            session = app.EXTENSION_SESSIONS[session_id]
            self.assertIs(session.get("autoFinalize"), True)
            self.assertEqual(session["profile"]["city"], "上海")

    def test_scheduled_start_refuses_without_enabled_schedule(self):
        with self.assertRaises(ValueError):
            app.start_scheduled_radar()

    def test_scheduled_start_refuses_when_radar_running(self):
        self._enable_schedule()
        app.start_scheduled_radar()
        with self.assertRaises(ValueError):
            app.start_scheduled_radar()

    def test_auto_finalize_marks_finalized_and_records_summary(self):
        self._enable_schedule()
        session_id, radar = app.start_scheduled_radar()
        job = make_job(1, id="sched-job-1")
        app.radar_record_batch(session_id, radar["currentTask"]["id"], {"jobs": [job]})
        with app.EXTENSION_INBOX_LOCK:
            app.EXTENSION_SESSIONS[session_id]["radar"]["status"] = "ready"

        def fake_finalize(_profile, jobs, _provider):
            return [{**item, "score": 88, "fitGrade": "A", "matchEngine": "ai"} for item in jobs], 0, None

        with patch.object(app, "finalize_radar_jobs", side_effect=fake_finalize):
            app._auto_finalize_scheduled_worker(session_id)

        with app.EXTENSION_INBOX_LOCK:
            session = app.EXTENSION_SESSIONS[session_id]
            self.assertEqual(session["radar"]["status"], "finalized")
            self.assertEqual(len(session["finalizedJobs"]), 1)
        self.assertEqual(app.LAST_SCHEDULED["summary"]["newCount"], 1)
        self.assertEqual(app.LAST_SCHEDULED["ids"], ["sched-job-1"])

    def test_store_roundtrip_preserves_schedule_and_session(self):
        self._enable_schedule()
        session_id, _radar = app.start_scheduled_radar()
        app._save_radar_store()

        with app.EXTENSION_INBOX_LOCK:
            app.EXTENSION_SESSIONS.clear()
            app.ACTIVE_EXTENSION_SESSION = None
            app.SCHEDULE_CONFIG.update({"enabled": False, "profile": None})
        app._load_radar_store()

        with app.EXTENSION_INBOX_LOCK:
            self.assertIn(session_id, app.EXTENSION_SESSIONS)
            self.assertTrue(app.SCHEDULE_CONFIG["enabled"])
            self.assertEqual(app.SCHEDULE_CONFIG["profile"]["city"], "上海")


class ZhaopinParserTests(unittest.TestCase):
    FIXTURE = Path(__file__).resolve().parent / "fixtures" / "zhaopin_joblist_sample.html"

    def test_parse_realistic_joblist_fixture(self):
        page_html = self.FIXTURE.read_text(encoding="utf-8")
        jobs = app.parse_zhaopin_jobs(page_html, limit=5)
        self.assertEqual(len(jobs), 2)
        first = jobs[0]
        self.assertEqual(first["id"], "zl-live-CCL1321031340J40138019907")
        self.assertIn("实习生", first["title"])
        self.assertIn("律师", first["company"])
        self.assertEqual(first["salary"], "1000-2000元")
        self.assertIn("重庆", first["location"])
        self.assertEqual(first["education"], "本科")
        self.assertIn("法律", first["tags"])
        self.assertTrue(first["url"].startswith("https://www.zhaopin.com/jobdetail/"))
        self.assertEqual(first["source"], "智联招聘公开页")

    def test_parse_rejects_page_without_job_cards(self):
        with self.assertRaises(ValueError):
            app.parse_zhaopin_jobs("<html><body>没有职位卡片</body></html>", limit=5)


class DomainConfigTests(unittest.TestCase):
    def test_derived_tables_match_domain_source(self):
        expected_families = [
            {
                "triggers": set(domain["triggers"]),
                "exact": list(domain["search"]["exact"]),
                "adjacent": list(domain["search"]["adjacent"]),
                "transferable": list(domain["search"]["transferable"]),
            }
            for domain in app.DOMAINS
        ]
        self.assertEqual(app.ROLE_SEARCH_FAMILIES, expected_families)

        expected_pages = [
            (tokens, urls)
            for domain in app.DOMAINS
            for tokens, urls in domain.get("zhaopinPages", [])
        ]
        self.assertEqual(app.ZHAOPIN_TOPIC_PAGES, expected_pages)
        self.assertEqual(app.SCORE_FAMILIES, [set(domain["skills"]) for domain in app.DOMAINS])

    def test_every_domain_skill_has_alias(self):
        for domain in app.DOMAINS:
            for skill in domain["skills"]:
                self.assertIn(skill, app.SKILL_ALIASES, f"{domain['id']} 的技能 {skill} 缺少别名")


if __name__ == "__main__":
    unittest.main()
