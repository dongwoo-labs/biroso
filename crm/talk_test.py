"""네이버 톡톡 자동 안내 시험. 연락 여정이 보내는 것과 같은 모양(sentFrom JOURNEY)으로 상담 창 하나에 1건을 넣고,
공용 CRM services/counsel이 실제로 보냈는지(보냄·실패) 기다려 보여 준다. 환자에게 가지 않도록 본인 상담 창으로 시험한다.

  TWENTY_URL=http://127.0.0.1:3030 TWENTY_API_KEY="$(cat .admin-key)" python3 crm/talk_test.py            # 최근 상담 창 10개
  TWENTY_URL=http://127.0.0.1:3030 TWENTY_API_KEY="$(cat .admin-key)" python3 crm/talk_test.py <상담 창 ID> # 시험 안내 보내기
"""
import sys, time
from datetime import datetime, timezone
from setup_clinic_objects import rest

TEXT = "[시험] 비로소한의원 자동 안내 시험이에요. 오늘 약침 치료 받으셨다면 시술 부위는 오늘 하루 물에 닿지 않게 해 주세요."


def ago(v):
    if not v:
        return "-"
    s = (datetime.now(timezone.utc) - datetime.fromisoformat(v.replace("Z", "+00:00"))).total_seconds()
    return f"{int(s // 3600)}시간 전" if s < 172800 else f"{int(s // 86400)}일 전"


def main(argv):
    if len(argv) < 2:
        rows = rest("GET", "/counselThreads?limit=10&order_by=lastMessageAt%5BDescNullsLast%5D&depth=1")["data"]["counselThreads"]
        print("상담 창 ID                              채널        고객 마지막 글  나감  환자 · 마지막 글")
        for t in rows:
            c = t.get("customer") or {}
            name = "".join(filter(None, [(c.get("name") or {}).get("lastName"), (c.get("name") or {}).get("firstName")])) or "(환자 연결 전)"
            print(f"{t['id']}  {t.get('channel') or '-':10}  {ago(t.get('lastInboundAt')):12}  {'예' if t.get('customerLeft') else '  '}    {name} · {(t.get('lastPreview') or '')[:20]}")
        print("\n본인 상담 창 ID를 넣어 다시 실행하세요. 네이버 톡톡은 고객이 마지막으로 보낸 지 오래된 창에는 보내기를 거절할 수 있어요.")
        return
    tid = argv[1]
    key = f"talk-test:{tid}:{int(time.time())}"
    m = rest("POST", "/counselMessages", {"counselThreadId": tid, "msgDirection": "OUT", "sendStatus": "QUEUED", "sentFrom": "JOURNEY", "messageText": TEXT, "dedupeKey": key})["data"]["createCounselMessage"]
    print("넣음:", m["id"], "· counsel 서비스가 5초 안에 보내요")
    for _ in range(12):
        time.sleep(5)
        r = rest("GET", f"/counselMessages/{m['id']}")["data"]["counselMessage"]
        if r.get("sendStatus") in ("SENT", "FAILED"):
            print("결과:", "보냄" if r["sendStatus"] == "SENT" else f"실패 · {r.get('error') or ''}")
            return
    print("1분 동안 대기 그대로예요. counsel 서비스가 떠 있는지 확인하세요: docker --context colima-selfhost compose -f ~/srv/crm/docker-compose.yml logs --tail 30 counsel")


if __name__ == "__main__":
    main(sys.argv)
