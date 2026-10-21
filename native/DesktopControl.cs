using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Started only by the human workbench takeover endpoint, never by an AI tool.
class DesktopControl {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenDesktop(string name,int flags,bool inherit,uint access);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SwitchDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [STAThread] static void Main(string[] args) {
        if(args.Length!=2 || !args[0].StartsWith("AgentDock_",StringComparison.Ordinal) || args[1]!="Default") return;
        IntPtr target=OpenDesktop(args[0],0,false,0x0100), home=OpenDesktop(args[1],0,false,0x0100);
        if(target==IntPtr.Zero || home==IntPtr.Zero) return;
        bool switched=false;
        try {
            Application.EnableVisualStyles();
            var form=new Form { Text="AgentDock · 人工接管", Width=370, Height=136, TopMost=true, FormBorderStyle=FormBorderStyle.FixedToolWindow, StartPosition=FormStartPosition.Manual, Location=new Point(12,12), BackColor=Color.FromArgb(247,249,253), Font=new Font("Microsoft YaHei",9) };
            var label=new Label { Text="AI 操作已暂停。请自行处理客户端确认。\n此工作桌面仍在你的电脑上，10 分钟后自动返回。", Left=16, Top=13, Width=334, Height=40 };
            var back=new Button { Text="返回我的桌面", Left=16, Top=63, Width=334, Height=32 };
            var timer=new System.Windows.Forms.Timer { Interval=600000 };
            Action leave=delegate { if(SwitchDesktop(home)) { switched=false; form.Close(); } else MessageBox.Show("返回桌面失败。请使用 Windows 的安全界面返回原桌面。","AgentDock"); };
            back.Click+=delegate { leave(); }; timer.Tick+=delegate { leave(); };
            form.Shown+=delegate { if(!SwitchDesktop(target)) { form.Close(); return; } switched=true; timer.Start(); };
            form.FormClosing+=delegate { timer.Stop(); if(switched && SwitchDesktop(home)) switched=false; };
            form.Controls.AddRange(new Control[]{label,back}); Application.Run(form); timer.Dispose();
        } finally { if(switched) SwitchDesktop(home); CloseDesktop(target); CloseDesktop(home); }
    }
}
