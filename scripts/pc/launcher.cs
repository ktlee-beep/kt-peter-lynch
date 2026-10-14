// KT 단타 수집기 실행 파일(KT-Collector.exe) 소스.
// scripts/pc/install-app.mjs 가 Windows 에 들어 있는 C# 컴파일러(.NET Framework 4, csc.exe)로 scripts/pc/bin/ 에 만든다.
//
// 하는 일: 검은 창 없이 node scripts/pc/panel.mjs 를 띄우고 끝난다. 제어판이 프로그램 창(엣지 앱 창)을 연다.
// 제어판이 이미 떠 있으면 panel.mjs 가 창만 다시 연다. 받은 인자(--port 4788 --no-open 등)는 panel.mjs 에 그대로 넘긴다.
// 제어판이 몇 초 안에 오류로 꺼지면 이유를 알 수 있게 메시지 창을 띄운다(자세한 내용은 scripts/pc/panel.log).
// 이 파일은 C# 5 문법만 쓴다(csc.exe v4 가 그 이상을 모른다).
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class Program
{
    const string Title = "KT 단타 수집기";

    [STAThread]
    static int Main(string[] args)
    {
        string binDir = AppDomain.CurrentDomain.BaseDirectory;
        string pcDir = Path.GetFullPath(Path.Combine(binDir, ".."));
        string panel = Path.Combine(pcDir, "panel.mjs");
        string root = Path.GetFullPath(Path.Combine(pcDir, "..", ".."));
        if (!File.Exists(panel)) return Fail("제어판 파일을 찾지 못했습니다.\n" + panel + "\n\n저장소 폴더를 옮겼다면 node scripts/pc/install-app.mjs 를 다시 실행하세요.");

        string node = FindNode(binDir);
        if (node == null) return Fail("Node.js(node.exe)를 찾지 못했습니다.\nNode.js 를 설치한 뒤 node scripts/pc/install-app.mjs 를 다시 실행하세요.");
        // 실행 중인 이 파일은 잠겨 있어 다시 만들 수 없다
        if (Array.IndexOf(args, "--install") >= 0) return Fail("설치(실행 파일 다시 만들기)는 명령 창에서 node scripts/pc/install-app.mjs 로 하세요.");

        StringBuilder line = new StringBuilder(Quote(panel));
        foreach (string a in args) line.Append(' ').Append(Quote(a));
        // 셸 실행 + 숨김 창: 이 실행 파일의 입출력 핸들을 제어판에 물려주지 않는다(물려주면 부른 쪽이 제어판이 꺼질 때까지 기다린다).
        ProcessStartInfo psi = new ProcessStartInfo(node, line.ToString());
        psi.WorkingDirectory = root;
        psi.UseShellExecute = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        Process p;
        try { p = Process.Start(psi); }
        catch (Exception e) { return Fail("제어판을 시작하지 못했습니다.\n" + e.Message); }

        if (p == null) return 0;
        // 정상이면 계속 돌거나(새로 뜸) 곧 0 으로 끝난다(이미 떠 있어 창만 엶). 오류 종료만 알린다.
        if (p.WaitForExit(8000) && p.ExitCode != 0)
            return Fail("제어판이 바로 꺼졌습니다(종료 코드 " + p.ExitCode + ").\n제어판 포트를 다른 프로그램이 쓰고 있을 수 있습니다.\n자세한 내용: " + Path.Combine(pcDir, "panel.log")
                + "\n(기록이 없으면 명령 창에서 node scripts/pc/panel.mjs 를 실행해 오류를 보세요)");
        return 0;
    }

    // install-app.mjs 가 적어 둔 경로 → PATH → 기본 설치 경로 순으로 찾는다.
    static string FindNode(string binDir)
    {
        try
        {
            string saved = File.ReadAllText(Path.Combine(binDir, "node-path.txt")).Trim();
            if (saved.Length > 0 && File.Exists(saved)) return saved;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            try
            {
                string c = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (File.Exists(c)) return c;
            }
            catch (ArgumentException) { }
        }
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (pf != null && File.Exists(Path.Combine(pf, @"nodejs\node.exe"))) return Path.Combine(pf, @"nodejs\node.exe");
        return null;
    }

    // Windows 명령줄 인자 규칙(CommandLineToArgvW)대로 감싼다.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
        StringBuilder sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in a)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', slashes); sb.Append(ch); }
            slashes = 0;
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static int Fail(string msg)
    {
        MessageBox.Show(msg, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
    }
}
