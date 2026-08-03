import json
import re
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import app


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
