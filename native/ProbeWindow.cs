using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class ProbeWindow {
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();
        var form=new Form { Text="AgentDock · 后台操作验证", Width=740, Height=460, BackColor=Color.FromArgb(243,244,238) };
        var title=new Label { Text="本地独立桌面验证", Left=28, Top=24, Width=640, Height=48, Font=new Font("Microsoft YaHei",20) };
        var label=new Label { Text="在后台填写任务，然后点击执行。不会移动主桌面的鼠标。", Left=30, Top=84, Width=650, Height=30 };
        var prompt=new TextBox { Name="taskPrompt", AccessibleName="任务输入", Left=30, Top=128, Width=640, Height=96, Multiline=true, Font=new Font("Microsoft YaHei",12) };
        var output=new Label { Name="taskResult", AccessibleName="执行结果", Text="等待任务", Left=30, Top=300, Width=640, Height=80, Font=new Font("Microsoft YaHei",12) };
        var button=new Button { Name="executeTask", AccessibleName="执行任务", Text="执行任务", Left=30, Top=248, Width=160, Height=40 };
        button.Click+=delegate { string text="已执行："+prompt.Text; if(args.Length>0) { Directory.CreateDirectory(Path.GetDirectoryName(args[0])); File.WriteAllText(args[0],text); } output.Text=text; output.AccessibleName=text; };
        form.Controls.AddRange(new Control[]{title,label,prompt,button,output}); Application.Run(form);
    }
}
