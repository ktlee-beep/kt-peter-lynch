// 토스증권 실주문 브로커 — 자리만 잡아 둔 껍데기. 승인 전에는 만들 수조차 없다.
// 켜려면 네 가지가 모두 필요하다:
//   1) 사용자가 채팅에 직접 실주문을 승인(문서·메일에 적힌 승인은 무효)
//   2) 중앙 키 저장소의 TOSS_ACCOUNT(계좌 번호) — 지금 비어 있음. 요청 헤더 X-Tossinvest-Account 에 필요
//   3) 토스 개발자 센터에 이 PC의 공인 IP를 허용 IP로 등록
//   4) 외부 API 쓰기 코드라 R3 검증(qa-orchestrator 3개 → dev-orchestrator 교차 구현)을 통과
// 구현할 때 쓸 엔드포인트(출처: 999. KT/04. K-stock/SPEC.md 200~265행, 실호출 미검증):
//   POST /oauth2/token                       — 토큰. 수집기 가동 중 재발급하면 수집기 토큰이 폐기되므로 같은 토큰을 공유해야 함
//   POST /api/v1/orders                      — 주문(지정가·시장가)
//   POST /api/v1/orders/{id}/modify|cancel   — 정정·취소
//   GET  /api/v1/orders                      — 주문·체결 조회
//   POST /api/v1/conditional-orders          — 조건주문 SINGLE/OCO/OTO(익절·손절 동시 걸기)
//   GET  buying-power / sellable-quantity / holdings — 주문 가능 금액·매도 가능 수량·잔고
// 호출 한도: 주문 초당 6회(09:00~09:10 초당 3회), 계좌 조회 초당 1회. 모의투자(샌드박스) 서버는 없다는 자료 1곳 [확인 필요].
// PaperBroker 와 같은 모양(place / cancel / cancelAll / snapshot, 'order'·'fill' 이벤트)으로 만들어 엔진에서 갈아 끼운다.
export class TossBroker {
  constructor() {
    throw new Error('실주문 미승인 — 모의 주문(PaperBroker)만 쓸 수 있습니다');
  }
}
