// 진료 예약 가능 시간 계산. 진료시간(clinic.json hours)을 칸으로 나누고 휴진일·지난 시간·찬 칸을 뺀다.
// 날짜·시간은 모두 한국 시간 기준이다(서버 시간대와 무관하게 +09:00으로 계산).

const KST = 9 * 3600_000;
const pad = (n) => String(n).padStart(2, "0");
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// 한국 날짜(YYYY-MM-DD)의 요일(0=일)
export const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const kstDate = (d) => new Date(d.getTime() + KST).toISOString().slice(0, 10);
export const kstIso = (date, time) => new Date(`${date}T${time}:00+09:00`).toISOString();

// 그 날 진료시간 안의 모든 칸(HH:MM). 마지막 칸은 마감 시각 한 칸 전에 시작한다.
export function daySlots(date, hours, minutes) {
  const h = hours.find((x) => x.days.includes(weekday(date)));
  if (!h) return [];
  const out = [];
  for (let t = toMin(h.open); t + minutes <= toMin(h.close); t += minutes) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  return out;
}

// taken: 그 날 이미 잡힌 예약 시각(ISO) 목록. 반환: [{ time, available }]
export function availableSlots(date, { hours, closures = [], taken = [], now = new Date(), minutes = 30, capacity = 1, leadHours = 2, days = 30 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || closures.includes(date)) return [];
  const today = kstDate(now);
  const last = kstDate(new Date(now.getTime() + days * 86400_000));
  if (date < today || date > last) return [];
  const counts = new Map();
  for (const iso of taken) counts.set(iso, (counts.get(iso) ?? 0) + 1);
  const earliest = now.getTime() + leadHours * 3600_000;
  return daySlots(date, hours, minutes).map((time) => {
    const iso = kstIso(date, time);
    return { time, available: Date.parse(iso) >= earliest && (counts.get(new Date(iso).toISOString()) ?? 0) < capacity };
  });
}
