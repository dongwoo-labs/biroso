"""import_upstream_history.py 계획 테스트. 실행: python3 -m unittest crm/test_import_history.py"""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(__file__))
import import_upstream_history as h

PEOPLE = {"00012": {"id": "p1"}, "00013": {"id": "p2"}}
MEMBERS = {"김비로": "m1", "비로": "m1"}
NOW = "2026-11-03T00:00:00Z"


class ParseTest(unittest.TestCase):
    def test_parse_dt_forms(self):
        self.assertEqual(h.parse_dt("2026-11-03 14:30"), "2026-11-03T05:30:00Z")
        self.assertEqual(h.parse_dt("2026.11.3 오후 2:30"), "2026-11-03T05:30:00Z")
        self.assertEqual(h.parse_dt("2026-11-03", "09:05"), "2026-11-03T00:05:00Z")
        self.assertEqual(h.parse_dt("2026-11-03T14:30:00"), "2026-11-03T05:30:00Z")
        self.assertEqual(h.parse_dt("46329.5"), "2026-11-03T03:00:00Z")  # 엑셀 일련번호 + 정오
        self.assertIsNone(h.parse_dt("2026-11-03"))  # 시각 없음
        self.assertIsNone(h.parse_dt("어제 3시"))

    def test_status_and_source(self):
        self.assertEqual(h.appt_status("예약취소", None, NOW), "CANCELLED")
        self.assertEqual(h.appt_status("노쇼", None, NOW), "NO_SHOW")
        self.assertEqual(h.appt_status("진료완료", None, NOW), "DONE")
        self.assertEqual(h.appt_status("", None, NOW), "CONFIRMED")
        self.assertIsNone(h.appt_status("보류", None, NOW))
        self.assertEqual(h.appt_source("네이버예약"), "NAVER")
        self.assertEqual(h.appt_source(""), "STAFF")

    def test_same_ignores_millis(self):
        self.assertTrue(h.same("2026-11-03T05:30:00.000Z", "2026-11-03T05:30:00Z"))
        self.assertFalse(h.same("2026-11-03T05:31:00.000Z", "2026-11-03T05:30:00Z"))


class AppointmentPlanTest(unittest.TestCase):
    ROWS = [
        {"차트번호": "00012", "예약일시": "2026-10-01 10:00", "상태": "완료", "진료의": "김비로 원장", "예약경로": "전화", "초재진": "초진", "예약ID": "a1"},
        {"차트번호": "00012", "예약일시": "2026-10-20 10:00", "상태": "확정", "예약ID": "a2"},
        {"차트번호": "99999", "예약일시": "2026-10-20 10:00", "상태": "확정"},
        {"차트번호": "00013", "예약일": "2026-11-10", "예약시간": "15:00", "상태": "예약", "진료의": "없는의사", "메모": "허리"},
        {"차트번호": "00013", "예약일": "2026-11-10", "예약시간": "15:00", "상태": "예약"},
        {"차트번호": "00013", "예약일시": "2026-11-10", "상태": "예약"},
    ]

    def test_plan(self):
        p = h.plan_appointments(self.ROWS, PEOPLE, MEMBERS, {}, NOW)
        self.assertEqual(len(p["create"]), 3)
        a1 = p["create"][0]
        self.assertEqual((a1["upstreamId"], a1["appointmentStatus"], a1["doctorId"], a1["source"], a1["visitType"]), ("upstream:appt:a1", "DONE", "m1", "PHONE", "NEW"))
        # ID 없는 줄은 차트번호+일시로 키를 만들고, 같은 키는 파일 안 중복
        self.assertEqual(p["create"][2]["upstreamId"], "upstream:appt:00013@2026-11-10T06:00:00Z")
        reasons = [w for _, w in p["skip"]]
        self.assertIn("차트번호가 환자에 없음", reasons)
        self.assertIn("파일 안에서 중복", reasons)
        self.assertIn("예약 일시를 읽지 못함", reasons)
        self.assertEqual(len(p["warn"]), 1)  # 없는 진료의
        self.assertEqual(p["past_open"], 1)  # 지난 확정 예약 a2
        self.assertEqual(p["by_status"], {"DONE": 1, "CONFIRMED": 2})

    def test_rerun_is_idempotent(self):
        first = h.plan_appointments(self.ROWS, PEOPLE, MEMBERS, {}, NOW)
        existing = {b["upstreamId"]: {**b, "id": f"x{i}", "scheduledAt": b["scheduledAt"].replace(":00Z", ":00.000Z")} for i, b in enumerate(first["create"])}
        again = h.plan_appointments(self.ROWS, PEOPLE, MEMBERS, existing, NOW)
        self.assertEqual((len(again["create"]), len(again["update"]), again["same"]), (0, 0, 3))
        # 업스트림에서 상태가 바뀌면 고친다
        rows = [dict(self.ROWS[1], 상태="취소")]
        changed = h.plan_appointments(rows, PEOPLE, MEMBERS, existing, NOW)
        self.assertEqual(changed["update"], [("x1", {"appointmentStatus": "CANCELLED"})])


class PackagePlanTest(unittest.TestCase):
    ROWS = [
        {"차트번호": "00012", "패키지명": "약침 10회", "유형": "횟수", "총횟수": "10", "잔여횟수": "6", "시작일시": "2026-09-01", "만료일시": "2027-03-01", "환자비급여패키지Id": "k1"},
        {"차트번호": "00013", "패키지명": "충전 50만", "유형": "정액", "총액": "500,000", "사용횟수": "120000", "환자비급여패키지Id": "k2"},
        {"차트번호": "00013", "패키지명": "끝난 것", "총횟수": "5", "잔여횟수": "0", "상태": "종료", "환자비급여패키지Id": "k3"},
        {"차트번호": "00012", "패키지명": "총량 없음", "환자비급여패키지Id": "k4"},
    ]
    USAGE = [
        {"환자비급여패키지Id": "k1", "사용내역Id": "u1", "진료일자": "2026-09-10", "차감횟수": "1", "취소여부": "N"},
        {"환자비급여패키지Id": "k1", "사용내역Id": "u2", "진료일자": "2026-09-17", "차감횟수": "1", "취소여부": "N"},
        {"환자비급여패키지Id": "k1", "사용내역Id": "u3", "진료일자": "2026-09-18", "차감횟수": "1", "취소여부": "Y"},
    ]

    @staticmethod
    def remaining(total, entries):
        return total - sum(e["amount"] if e["entryKind"] == "USE" else -e["amount"] for e in entries)

    def test_plan_matches_upstream_remaining(self):
        p = h.plan_packages(self.ROWS, self.USAGE, PEOPLE, {}, set())
        self.assertEqual(len(p["create"]), 3)
        self.assertEqual(p["skip"], [(5, "총횟수·총액 없음")])
        self.assertEqual(p["usage_cancelled"], 1)
        for body, entries in p["create"]:
            self.assertEqual(self.remaining(body["total"], entries), body["remaining"], body["name"])
        k1, e1 = p["create"][0]
        self.assertEqual([e["upstreamId"] for e in e1], ["upstream:use:u1", "upstream:use:u2", "upstream:pkg:k1:gap"])
        self.assertEqual(e1[2]["amount"], 2)  # 10 - 6 - 2(사용내역)
        k2, e2 = p["create"][1]
        self.assertEqual((k2["kind"], k2["total"], k2["remaining"]), ("AMOUNT", 500000, 380000))
        self.assertEqual(p["create"][2][0]["packageStatus"], "ENDED")
        self.assertEqual(p["totals"]["COUNT"], [15, 6])  # 종료된 패키지 잔여는 빼고

    def test_more_usage_than_upstream_used_adds_cancel(self):
        rows = [dict(self.ROWS[0], 잔여횟수="9")]
        p = h.plan_packages(rows, self.USAGE, PEOPLE, {}, set())
        body, entries = p["create"][0]
        self.assertEqual((entries[-1]["entryKind"], entries[-1]["amount"]), ("CANCEL", 1))
        self.assertEqual(self.remaining(body["total"], entries), 9)

    def test_rerun_adds_only_missing_entries(self):
        p = h.plan_packages(self.ROWS[:1], self.USAGE, PEOPLE, {"upstream:pkg:k1": {"id": "pp1"}}, {"upstream:use:u1"})
        self.assertEqual(p["create"], [])
        self.assertEqual(p["same"], 1)
        self.assertEqual([(pid, e["upstreamId"]) for pid, e in p["entries"]], [("pp1", "upstream:use:u2"), ("pp1", "upstream:pkg:k1:gap")])

    def test_report_has_no_personal_values(self):
        p = h.plan_packages(self.ROWS, self.USAGE, PEOPLE, {}, set())
        text = str(h.report_of("packages", p, self.ROWS))
        self.assertNotIn("00012", text)
        self.assertNotIn("p1", text)


if __name__ == "__main__":
    unittest.main()
