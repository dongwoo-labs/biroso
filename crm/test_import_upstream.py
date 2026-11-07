"""import_upstream_patients.py의 파일 읽기·값 바꾸기·계획 테스트. 실행: python3 -m unittest crm/test_import_upstream.py"""
import os, sys, tempfile, unittest, zipfile

sys.path.insert(0, os.path.dirname(__file__))
import import_upstream_patients as im

HEAD = ["환자명", "성별", "나이", "차트번호", "생년월일", "휴대폰번호", "전화번호", "최초내원일", "최종내원일", "주소", "특이사항", "소개자", "가족", "광고수신동의여부", "알림공지수신동의여부"]


def xlsx(rows):
    """sharedStrings를 쓰는 최소 xlsx를 만든다(업스트림 파일처럼 모든 값이 문자열)."""
    strings = []
    def sid(v):
        if v not in strings:
            strings.append(v)
        return strings.index(v)
    cols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    body = "".join(
        f'<row r="{r + 1}">' + "".join(f'<c r="{cols[c]}{r + 1}" t="s"><v>{sid(v)}</v></c>' for c, v in enumerate(row) if v != "") + "</row>"
        for r, row in enumerate(rows))
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    path = tempfile.mktemp(suffix=".xlsx")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>" + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f"<worksheet {ns}><sheetData>{body}</sheetData></worksheet>")
    return path


class ImportTest(unittest.TestCase):
    def test_xlsx_keeps_leading_zero_and_blank_cells(self):
        rows = im.read_xlsx(xlsx([HEAD, ["홍길동", "남", "40", "000761", "1985-03-02", "010-1234-5678", "", "2024.01.05", "2026.10.30", "", "", "", "", "Y", "Y"]]))
        self.assertEqual(rows[0]["차트번호"], "000761")
        self.assertEqual(rows[0]["전화번호"], "")
        self.assertEqual(rows[0]["알림공지수신동의여부"], "Y")

    def test_values(self):
        self.assertEqual(im.parse_date("1985.3.2"), "1985-03-02")
        self.assertEqual(im.parse_date("19850302"), "1985-03-02")
        self.assertEqual(im.parse_date("32204"), "1988-03-02")
        self.assertIsNone(im.parse_date("1985-13-40"))
        self.assertEqual(im.parse_phone("010-1234-5678"), "1012345678")
        self.assertEqual(im.parse_phone("+82 10 1234 5678"), "1012345678")
        self.assertEqual(im.parse_phone("051-123-4567"), "511234567")
        self.assertIsNone(im.parse_phone("1234"))
        self.assertEqual(im.split_name("남궁민수"), {"lastName": "남궁", "firstName": "민수"})
        self.assertEqual(im.parse_yes("N"), False)
        self.assertIsNone(im.parse_yes("모름"))

    def test_plan_by_chart_number_not_phone(self):
        r = lambda name, chart, phone, ad="N": dict(zip(HEAD, [name, "여", "", chart, "1990-01-01", phone, "", "", "", "", "", "", "", ad, "Y"]))
        rows = [r("김엄마", "100", "010-1111-2222", "Y"), r("김아이", "101", "010-1111-2222"), r("박기존", "200", "010-3333-4444"), r("", "", ""), r("중복", "100", "")]
        existing = {"200": {"id": "p200", "chartNo": "200", "name": {"lastName": "박", "firstName": "기존"}, "sex": "F", "birthDate": "1990-01-01T00:00:00.000Z",
                            "phones": {"primaryPhoneNumber": "1033334444", "primaryPhoneCountryCode": "KR", "primaryPhoneCallingCode": "+82", "additionalPhones": []},
                            "consentMarketing": False, "consentNotice": True}}
        p = im.plan(rows, existing)
        self.assertEqual([x["chartNo"] for x in p["create"]], ["100", "101"])  # 같은 번호여도 두 환자
        self.assertEqual(p["shared_phones"], {"1011112222": 2})
        self.assertEqual(len(p["same"]), 1)  # 바뀐 칸이 없으면 고치지 않는다
        self.assertEqual([i for i, _ in p["skip"]], [5, 6])
        self.assertTrue(p["create"][0]["consentMarketing"])


if __name__ == "__main__":
    unittest.main()
