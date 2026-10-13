// 실제 server.js를 띄우는 테스트의 종료 처리.
//
// server.js는 서버 인스턴스를 export하지 않고 node-cron 잡을 등록하므로 이벤트 루프가
// 절대 스스로 비지 않는다 — process.exit()로 끊는 수밖에 없다. 그런데 Windows에서
// keep-alive 소켓이 살아 있는 채로 exit하면 libuv가 종료 중에 닫히는 async 핸들을
// 다시 건드려 abort한다(src\win\async.c:76). 화면에는 "통과 30 / 실패 0"이 그대로
// 찍히는데 종료코드만 0이 아니게 되므로, 종료코드로 성패를 보는 러너에서는 통과한
// 테스트가 실패로 잡힌다. 실제로 screener-message는 13/13 통과에 exit 127이었다.
//
// 그래서 핸들을 먼저 명시적으로 닫고, 닫힘이 끝날 틈을 한 번 준 뒤에 exit한다.
// 대기만으로도 대체로 통과하지만 그건 undici가 소켓을 알아서 정리해 주기를 기대하는
// 것이라 부하에 따라 흔들린다 — 닫는 쪽이 결과를 우리가 정한다.
export async function exitClean(code) {
  for (const h of process._getActiveHandles()) {
    try { if (h.constructor?.name === 'Socket') h.destroy(); else h.close?.(); } catch {}
  }
  await new Promise(r => setTimeout(r, 50));
  process.exit(code);
}
