// KT Trading — 이메일 발송 (Gmail SMTP / nodemailer)
// 환경변수:
//   GMAIL_USER          발신 Gmail 주소 (예: yourname@gmail.com)
//   GMAIL_APP_PASSWORD  Gmail 앱 비밀번호 (2단계 인증 후 발급, 16자리)
//   MAIL_FROM           (선택) 발신자 표기. 기본값: "KT 트레이딩 <GMAIL_USER>"
// 미설정 시 실제 발송 대신 콘솔에 코드를 출력(개발/로컬 폴백)한다.
import nodemailer from 'nodemailer';

let _transport = null;

export function isMailConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransport() {
  if (!isMailConfigured()) return null;
  if (!_transport) {
    _transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return _transport;
}

function codeEmailHtml(code) {
  return `
  <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#18181b;color:#fafafa;border-radius:16px;padding:36px 32px;border:1px solid #27272a">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:22px;font-weight:700;color:#ef4444">📈 KT 트레이딩</div>
      <div style="font-size:13px;color:#71717a;margin-top:4px">피터 린치 투자 시스템</div>
    </div>
    <p style="font-size:15px;color:#e4e4e7;margin:0 0 16px">회원가입 인증코드입니다. 아래 6자리 코드를 입력해주세요.</p>
    <div style="text-align:center;background:#09090b;border:1px solid #3f3f46;border-radius:10px;padding:18px;margin:0 0 16px">
      <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:#fafafa">${code}</span>
    </div>
    <p style="font-size:13px;color:#a1a1aa;margin:0 0 4px">· 인증코드는 <b>10분간</b> 유효합니다.</p>
    <p style="font-size:13px;color:#a1a1aa;margin:0">· 본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
  </div>`;
}

// 인증코드 이메일 발송. 반환: { ok, fallback } — fallback=true면 SMTP 미설정으로 콘솔 출력됨
export async function sendVerificationCode(email, code) {
  const transport = getTransport();
  if (!transport) {
    console.log(`[mailer] SMTP 미설정 — 콘솔 폴백. ${email} 인증코드: ${code}`);
    return { ok: true, fallback: true };
  }
  const from = process.env.MAIL_FROM || `KT 트레이딩 <${process.env.GMAIL_USER}>`;
  await transport.sendMail({
    from,
    to: email,
    subject: '[KT 트레이딩] 회원가입 인증코드',
    text: `KT 트레이딩 회원가입 인증코드: ${code}\n\n10분 이내에 입력해주세요.\n본인이 요청하지 않았다면 이 메일을 무시하세요.`,
    html: codeEmailHtml(code),
  });
  return { ok: true, fallback: false };
}
