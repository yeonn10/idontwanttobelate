# 452번 출발 계산기

서울 452번 버스 · 반포역(22017) → 중앙대학교(20194)

- 버스 위치와 실시간 도착정보로 반포역 도착 시각을 구하고, 걷는 시간(기본 8분)을 빼서 집 출발 시각을 계산해요.
- 중앙대학교 도착 예상 시각과, 도착 마감 시각에 맞춘 마지노선 출발 시각도 보여줘요.

## 구조
- `index.html` : 화면 (GitHub Pages로 호스팅)
- `worker/worker.js` : API 중계 (Cloudflare Workers). 서울시 API 키는 여기 환경변수에만 둬요.

## 설정
1. data.go.kr에서 "서울특별시 버스도착정보조회 서비스", "서울특별시 버스위치정보조회 서비스" 활용 신청 후 일반 인증키 발급
2. Cloudflare Workers에 `worker/worker.js` 배포, Secret `BUS_API_KEY`에 인증키 입력
3. `index.html` 위쪽의 `API_URL`을 내 Worker 주소로 변경
4. GitHub 저장소 Settings → Pages → Branch `main` / root 로 켜기

키가 없으면 Worker는 샘플 데이터로 동작해요.
