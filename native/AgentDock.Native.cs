using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// The native bridge uses UIA patterns and window messages only. It never calls
// SendInput or SetForegroundWindow, and never moves the user's cursor. A separate
// human-only desktop controller provides explicit takeover and a return button.
class DockNative {
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16000000 };
    static Dictionary<string, IntPtr> Desktops = new Dictionary<string, IntPtr>();
    static Dictionary<string, Observation> Observations = new Dictionary<string, Observation>();
    static List<int> OwnedProcesses = new List<int>();
    class Observation { public IntPtr Window; public uint Pid; public DateTime Time; public List<AutomationElement> Elements = new List<AutomationElement>(); }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize,flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public RECT caretRect; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved, desktop, title; public int x,y,xsize,ysize,xcount,ycount,fill,flags; public short show,reserved2; public IntPtr bytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
    delegate bool EnumWindow(IntPtr hwnd, IntPtr arg);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr devmode,int flags,uint access,IntPtr security);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenDesktop(string name,int flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(int flags,bool inherit,uint access);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int bytes,out int needed);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread,ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop,EnumWindow callback,IntPtr arg);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumWindow callback,IntPtr arg);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,IntPtr wparam,string lparam,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendMessageTimeoutPtr(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd,ref POINT point);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent,POINT point,uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttr,IntPtr threadAttr,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static Dictionary<string,object> Map(params object[] items) { var d = new Dictionary<string,object>(); for(int i=0;i<items.Length;i+=2) d[(string)items[i]]=items[i+1]; return d; }
    static string Str(Dictionary<string,object> a,string key,string fallback="") { return a.ContainsKey(key) && a[key]!=null ? Convert.ToString(a[key]) : fallback; }
    static int Num(Dictionary<string,object> a,string key,int fallback=0) { return a.ContainsKey(key) ? Convert.ToInt32(a[key]) : fallback; }
    static object Finite(double value) { return Double.IsNaN(value) || Double.IsInfinity(value) ? null : (object)value; }
    static string Title(IntPtr hwnd) { var b=new StringBuilder(4096); GetWindowText(hwnd,b,b.Capacity); return b.ToString(); }
    static string Class(IntPtr hwnd) { var b=new StringBuilder(256); GetClassName(hwnd,b,b.Capacity); return b.ToString(); }
    static bool NativeEdit(AutomationElement e) { var c=e.Current; return !c.IsPassword && c.NativeWindowHandle!=0 && Class(new IntPtr(c.NativeWindowHandle)).IndexOf("EDIT",StringComparison.OrdinalIgnoreCase)>=0; }
    static bool RichEditor(AutomationElement e) { return e.Current.IsKeyboardFocusable && e.Current.ClassName.Split(' ').Contains("ProseMirror"); }
    static string EditorText(AutomationElement e,string value) {
        // These empty-composer placeholders are present in Doubao's TextPattern.
        // Other text is preserved, including drafts and all message content.
        if(RichEditor(e) && (value.Trim()=="发消息..." || value.Trim()=="发消息或按住空格说话..." || value.Trim()=="发消息或创建任务... / 使用技能 @ 添加资料")) return "";
        return value;
    }
    static string CurrentText(AutomationElement e) {
        object pattern;
        if(e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) return ((ValuePattern)pattern).Current.Value;
        if(e.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return EditorText(e,((TextPattern)pattern).DocumentRange.GetText(16000));
        throw new InvalidOperationException("输入控件无法回读，不能确认后台填写结果");
    }
    static string NormalizeText(string text) { return (text ?? "").Replace("\r\n","\n").TrimEnd('\n'); }
    static bool VerifyText(AutomationElement e,string value,int milliseconds) {
        var watch=Stopwatch.StartNew();
        do { if(NormalizeText(CurrentText(e))==NormalizeText(value)) return true; Thread.Sleep(50); } while(watch.ElapsedMilliseconds<milliseconds);
        return false;
    }
    static void BackgroundCharacters(IntPtr window,AutomationElement e,string desktop,string value) {
        // Experimental, directed window messages only. Never send Enter, shortcuts,
        // clipboard input or global input, and never overwrite an existing draft.
        if(!desktop.StartsWith("AgentDock_",StringComparison.Ordinal) || Class(window)!="Chrome_WidgetWin_1" || (e.Current.ControlType!=ControlType.Edit && !RichEditor(e)) || value.Length>8000 || value.Any(c=>Char.IsControl(c)) || !String.IsNullOrWhiteSpace(CurrentText(e))) throw new InvalidOperationException("该输入框不支持已验证的后台填写；定向字符适配仅支持独立桌面的空输入框和单行文字");
        var recipient=BackgroundRecipient(window,e,desktop);
        foreach(char c in value) { IntPtr receipt; if(SendMessageTimeoutPtr(recipient,0x0102,new IntPtr(c),new IntPtr(1),2,1000,out receipt)==IntPtr.Zero) throw new InvalidOperationException("定向字符输入超时，请重新观察草稿，禁止重复填写"); }
    }
    static IntPtr BackgroundRecipient(IntPtr window,AutomationElement e,string desktop) {
        if(!desktop.StartsWith("AgentDock_",StringComparison.Ordinal) || Class(window)!="Chrome_WidgetWin_1" || IsIconic(window)) throw new InvalidOperationException("定向输入仅用于未最小化的独立客户端窗口");
        var input=OpenInputDesktop(0,false,0x0001); if(input==IntPtr.Zero) throw new InvalidOperationException("无法核实当前输入桌面，已停止定向输入");
        var name=new StringBuilder(256); int needed;
        try { if(!GetUserObjectInformation(input,2,name,512,out needed) || name.ToString()==desktop) throw new InvalidOperationException("工作桌面正在接管或无法核实，已停止定向输入"); } finally { CloseDesktop(input); }
        e.SetFocus(); Thread.Sleep(100);
        uint pid; uint thread=GetWindowThreadProcessId(window,out pid); var info=new GUITHREADINFO(); info.cbSize=Marshal.SizeOf(info);
        bool domFocus=e.Current.HasKeyboardFocus, readable=GetGUIThreadInfo(thread,ref info);
        if(!domFocus) throw new InvalidOperationException("无法确认富文本控件焦点（UIA=false），已停止定向输入");
        // Chromium-based clients can retain DOM focus while an inactive native
        // queue reports no focus HWND. In that case messages still target only
        // this exact, bound Chrome window; text must be read back in this editor.
        var targets=RenderTargets(window);
        IntPtr recipient=readable && info.focus!=IntPtr.Zero ? info.focus : targets.Count==1 ? targets[0] : window;
        if(recipient!=window && !IsChild(window,recipient)) throw new InvalidOperationException("后台焦点指向另一个窗口，已停止定向输入");
        uint focusPid;
        GetWindowThreadProcessId(recipient,out focusPid); if(focusPid!=pid) throw new InvalidOperationException("输入焦点进程不匹配，已停止");
        return recipient;
    }
    static IntPtr Desktop(string name) {
        if(Desktops.ContainsKey(name)) return Desktops[name];
        var h=OpenDesktop(name=="default" ? "Default" : name,0,false,0x01FF);
        if(h==IntPtr.Zero) throw new InvalidOperationException("无法打开本地桌面，Windows 错误 "+Marshal.GetLastWin32Error());
        Desktops[name]=h; return h;
    }
    static List<IntPtr> Windows(IntPtr desktop) {
        var list=new List<IntPtr>(); EnumDesktopWindows(desktop,delegate(IntPtr h,IntPtr v) { if(IsWindowVisible(h) && Title(h).Length>0) list.Add(h); return true; },IntPtr.Zero); return list;
    }
    static List<IntPtr> RenderTargets(IntPtr window) {
        var result=new List<IntPtr>(); uint owner; GetWindowThreadProcessId(window,out owner);
        EnumChildWindows(window,delegate(IntPtr child,IntPtr unused) {
            uint pid; GetWindowThreadProcessId(child,out pid);
            if(pid==owner && IsWindowVisible(child) && Class(child)=="Chrome_RenderWidgetHostHWND") result.Add(child);
            return true;
        },IntPtr.Zero); return result;
    }
    static object WindowInfo(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h,out pid); string exe="";
        try { exe=Process.GetProcessById((int)pid).MainModule.FileName; } catch { }
        RECT r; GetWindowRect(h,out r);
        return Map("id",h.ToInt64(),"title",Title(h),"className",Class(h),"pid",pid,"executable",exe,"width",r.Right-r.Left,"height",r.Bottom-r.Top,"minimized",IsIconic(h));
    }
    static IntPtr CheckedWindow(Dictionary<string,object> a) {
        var h=new IntPtr(Convert.ToInt64(a["window"]));
        if(!IsWindow(h) || !Windows(Desktop(Str(a,"desktop","default"))).Contains(h)) throw new InvalidOperationException("窗口已关闭、移动到其他桌面，或不可访问，请重新绑定");
        uint pid; GetWindowThreadProcessId(h,out pid);
        if(a.ContainsKey("expectedPid") && pid!=Convert.ToUInt32(a["expectedPid"])) throw new InvalidOperationException("窗口所属进程已变化，请重新绑定");
        string cls=Class(h); if(cls=="ConsoleWindowClass" || cls.Contains("CASCADIA")) throw new InvalidOperationException("此组件不操作终端窗口");
        try { if(Path.GetFileName(Process.GetProcessById((int)pid).MainModule.FileName)=="AgentDock.Desktop.exe") throw new InvalidOperationException("人工接管面板不能由 AI 操作"); } catch(System.ComponentModel.Win32Exception) { }
        return h;
    }
    static object Screenshot(IntPtr h) {
        if(IsIconic(h)) return Map("available",false,"reason","窗口已最小化，请先由用户恢复官方客户端窗口");
        RECT r; GetWindowRect(h,out r); int w=r.Right-r.Left, height=r.Bottom-r.Top;
        if(w<2 || height<2 || w>8192 || height>8192) return Map("available",false,"reason","窗口尺寸不可捕获");
        using(var bitmap=new Bitmap(w,height)) {
            bool ok; using(var graphics=Graphics.FromImage(bitmap)) {
                graphics.Clear(Color.FromArgb(10,10,10)); var dc=graphics.GetHdc();
                try { ok=PrintWindow(h,dc,2); if(!ok) ok=PrintWindow(h,dc,0); } finally { graphics.ReleaseHdc(dc); }
            }
            long variation=0; var first=bitmap.GetPixel(w/2,height/2);
            for(int x=w/20;x<w;x+=Math.Max(1,w/10)) for(int y=height/20;y<height;y+=Math.Max(1,height/10)) { var c=bitmap.GetPixel(x,y); variation+=Math.Abs(c.R-first.R)+Math.Abs(c.G-first.G)+Math.Abs(c.B-first.B); }
            if(!ok || variation<100) return Map("available",false,"reason","该窗口没有提供有效的后台画面；请人工接管或使用兼容环境", "width",w,"height",height);
            double scale=Math.Min(1.0,1600.0/w); using(var resized=new Bitmap(bitmap,new Size((int)(w*scale),(int)(height*scale)))) using(var stream=new MemoryStream()) {
                resized.Save(stream,ImageFormat.Png); return Map("available",true,"data",Convert.ToBase64String(stream.ToArray()),"mimeType","image/png","width",resized.Width,"height",resized.Height,"scale",scale);
            }
        }
    }
    static object Observe(IntPtr h,bool capture,bool backgroundDesktop) {
        uint pid; GetWindowThreadProcessId(h,out pid);
        var obs=new Observation { Window=h, Pid=pid, Time=DateTime.UtcNow }; var rows=new List<object>(); var text=new StringBuilder();
        var walker=TreeWalker.ControlViewWalker; var watch=Stopwatch.StartNew(); bool partial=false;
        var cache=new CacheRequest(); cache.TreeScope=TreeScope.Element;
        foreach(var property in new[]{AutomationElement.NameProperty,AutomationElement.AutomationIdProperty,AutomationElement.ControlTypeProperty,AutomationElement.ClassNameProperty,AutomationElement.IsPasswordProperty,AutomationElement.IsEnabledProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsKeyboardFocusableProperty,AutomationElement.HasKeyboardFocusProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.NativeWindowHandleProperty,AutomationElement.IsValuePatternAvailableProperty,AutomationElement.IsTextPatternAvailableProperty,AutomationElement.IsInvokePatternAvailableProperty,ValuePattern.ValueProperty,ValuePattern.IsReadOnlyProperty}) cache.Add(property);
        cache.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
        var root=AutomationElement.FromHandle(h).GetUpdatedCache(cache);
        Action<AutomationElement,int> walk=null;
        walk=delegate(AutomationElement e,int depth) {
            if(e==null) return;
            if(depth>32 || obs.Elements.Count>=1200) { partial=true; return; }
            if(watch.ElapsedMilliseconds>6500) { partial=true; return; }
            try {
                var c=e.Cached; int index=obs.Elements.Count; obs.Elements.Add(e); bool password=c.IsPassword;
                string name=password ? "[密码字段]" : c.Name; string value=""; object p;
                bool hasValue=(bool)e.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty);
                bool hasText=(bool)e.GetCachedPropertyValue(AutomationElement.IsTextPatternAvailableProperty);
                bool hasInvoke=(bool)e.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty);
                bool writable=hasValue && Object.Equals(e.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty,true),false);
                if(!password && hasValue) value=e.GetCachedPropertyValue(ValuePattern.ValueProperty,true) as string ?? "";
                else if(!password && hasText && e.TryGetCurrentPattern(TextPattern.Pattern,out p)) value=((TextPattern)p).DocumentRange.GetText(16000);
                if(value.Length>16000) value=value.Substring(0,16000);
                if(text.Length>160000) { value=""; partial=true; }
                var bounds=c.BoundingRectangle;
                bool nativeEdit=!password && c.NativeWindowHandle!=0 && Class(new IntPtr(c.NativeWindowHandle)).IndexOf("EDIT",StringComparison.OrdinalIgnoreCase)>=0;
                bool rich=backgroundDesktop && !password && c.IsKeyboardFocusable && c.ClassName.Split(' ').Contains("ProseMirror"); if(rich) value=EditorText(e,value);
                rows.Add(Map("index",index,"depth",depth,"name",name,"automationId",c.AutomationId,"type",c.ControlType.ProgrammaticName.Replace("ControlType.",""),"className",c.ClassName,"value",value,"password",password,"enabled",c.IsEnabled,"offscreen",c.IsOffscreen,"focusable",c.IsKeyboardFocusable,"focused",c.HasKeyboardFocus,"canSetValue",!password && (writable || nativeEdit || rich),"canInvoke",hasInvoke,"canExpand",(bool)e.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty),"rect",Map("x",Finite(bounds.X),"y",Finite(bounds.Y),"width",Finite(bounds.Width),"height",Finite(bounds.Height))));
                if(!password && !String.IsNullOrWhiteSpace(name)) text.AppendLine(name);
                if(!password && !String.IsNullOrWhiteSpace(value)) text.AppendLine(value);
                var child=walker.GetFirstChild(e,cache); while(child!=null && obs.Elements.Count<1200 && watch.ElapsedMilliseconds<=6500) { walk(child,depth+1); child=walker.GetNextSibling(child,cache); }
            } catch(ElementNotAvailableException) { } catch(InvalidOperationException) { }
        };
        walk(root,0); partial=partial || obs.Elements.Count>=1200 || watch.ElapsedMilliseconds>6500;
        string token=Guid.NewGuid().ToString("N"); Observations[token]=obs;
        foreach(var k in Observations.Where(v=>(DateTime.UtcNow-v.Value.Time).TotalMinutes>3).Select(v=>v.Key).ToList()) Observations.Remove(k);
        return Map("window",WindowInfo(h),"renderTargets",RenderTargets(h).Select(WindowInfo).ToArray(),"token",token,"elements",rows,"text",text.ToString(),"partial",partial,"readDurationMs",watch.ElapsedMilliseconds,"screenshot",capture ? Screenshot(h) : Map("available",false,"requested",false,"reason","此次仅检查控件文字，未请求截图"),"inputMode","background-uia", "notice",partial ? "窗口内容仅部分可读，请核实缺失控件；不会把部分文字当作完整回复。" : "后台控件操作不抢占鼠标；未暴露可操作控件的客户端需要人工接管。隔离桌面兼容性仍属实验。");
    }
    static AutomationElement Element(Dictionary<string,object> a,IntPtr h) {
        Observation o; if(!Observations.TryGetValue(Str(a,"token"),out o) || o.Window!=h || (DateTime.UtcNow-o.Time).TotalSeconds>90) throw new InvalidOperationException("观察已过期，请重新观察");
        uint pid; GetWindowThreadProcessId(h,out pid); if(pid!=o.Pid) throw new InvalidOperationException("窗口进程已变化，请重新观察");
        int i=Num(a,"elementIndex",-1); if(i<0 || i>=o.Elements.Count) throw new InvalidOperationException("需要选择当前观察里的控件");
        var e=o.Elements[i]; if(e.Current.IsPassword) throw new InvalidOperationException("登录与密码字段需要用户接管");
        var current=e.Current;
        if(current.ClassName.IndexOf("permissionModeTrigger",StringComparison.OrdinalIgnoreCase)>=0 || System.Text.RegularExpressions.Regex.IsMatch(current.Name,@"信任.*(作者|文件夹)|手动审批|允许.*访问|接受.*条款|同意.*协议")) throw new InvalidOperationException("此确认需要由用户在人工接管中处理，AI 不会代为批准");
        if(!e.Current.IsEnabled) throw new InvalidOperationException("控件不可用"); return e;
    }
    static object Act(string action,Dictionary<string,object> a) {
        var h=CheckedWindow(a); var e=Element(a,h); object pattern; IntPtr foreground=GetForegroundWindow(); POINT before; bool beforeValid=GetCursorPos(out before);
        if(action=="set_value") {
            if(IsIconic(h)) throw new InvalidOperationException("客户端窗口已最小化，后台输入已停止；请先恢复工作桌面中的窗口");
            // Some Chromium editors require DOM focus before an accessibility
            // value action. Never request focus on the user's ordinary desktop.
            if(Str(a,"desktop").StartsWith("AgentDock_",StringComparison.Ordinal) && Class(h)=="Chrome_WidgetWin_1" && e.Current.ControlType==ControlType.Edit && e.Current.IsKeyboardFocusable) e.SetFocus();
            // In isolated Chromium editors use one directed fill only. UIA can
            // cache an empty value after input was accepted; retrying characters
            // based on that stale value would duplicate the task draft.
            if(Str(a,"desktop").StartsWith("AgentDock_",StringComparison.Ordinal) && Class(h)=="Chrome_WidgetWin_1" && (RichEditor(e) || (e.Current.ControlType==ControlType.Edit && !NativeEdit(e)))) BackgroundCharacters(h,e,Str(a,"desktop"),Str(a,"value"));
            else if(e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) ((ValuePattern)pattern).SetValue(Str(a,"value"));
            else if(NativeEdit(e)) { IntPtr result; if(SendMessageTimeout(new IntPtr(e.Current.NativeWindowHandle),0x000C,IntPtr.Zero,Str(a,"value"),2,2000,out result)==IntPtr.Zero) throw new InvalidOperationException("本地输入框没有确认填写，结果需要重新观察"); }
            else if(RichEditor(e)) BackgroundCharacters(h,e,Str(a,"desktop"),Str(a,"value"));
            else throw new InvalidOperationException("此输入框不支持后台填写，已停止；不会切换到前台输入");
            // A provider can acknowledge an asynchronous action without changing
            // its editor. Read back the actual value before permitting a send.
            int readbackMilliseconds=Math.Min(6000,Math.Max(100,Num(a,"readbackTimeoutMs",6000)));
            if(!VerifyText(e,Str(a,"value"),readbackMilliseconds)) throw new InvalidOperationException("暂未读回完整草稿，已停止发送；请重新观察确认，禁止再次填写");
        } else if(action=="invoke") {
            if(!e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) throw new InvalidOperationException("此控件不支持后台点击，已停止；请手动接管");
            ((InvokePattern)pattern).Invoke();
        } else if(action=="dismiss_menu") {
            // Only Escape, only an observed menu on the bound background desktop.
            // No global input, no Enter, and no arbitrary shortcut facility.
            string desktop=Str(a,"desktop");
            if(e.Current.ControlType!=ControlType.Menu || !desktop.StartsWith("AgentDock_",StringComparison.Ordinal) || Class(h)!="Chrome_WidgetWin_1" || IsIconic(h)) throw new InvalidOperationException("只能关闭独立客户端中已观察到的菜单");
            var inputDesktop=OpenInputDesktop(0,false,0x0001);if(inputDesktop==IntPtr.Zero)throw new InvalidOperationException("无法核实当前桌面");
            var desktopName=new StringBuilder(256);int needed;
            try {if(!GetUserObjectInformation(inputDesktop,2,desktopName,512,out needed)||desktopName.ToString()==desktop)throw new InvalidOperationException("用户正在接管该桌面，菜单操作停止");}finally{CloseDesktop(inputDesktop);}
            var targets=RenderTargets(h);if(targets.Count!=1)throw new InvalidOperationException("菜单窗口的输入目标不唯一，已停止");
            if(!PostMessage(h,0x0100,new IntPtr(0x1B),new IntPtr(0x00010001)) || !PostMessage(h,0x0101,new IntPtr(0x1B),new IntPtr(unchecked((int)0xC0010001))))throw new InvalidOperationException("关闭菜单失败，请重新观察");
        } else if(action=="expand" || action=="collapse") {
            if(!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)) throw new InvalidOperationException("此控件不支持后台展开");
            if(action=="expand") ((ExpandCollapsePattern)pattern).Expand(); else ((ExpandCollapsePattern)pattern).Collapse();
        } else if(action=="select") {
            if(!e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)) throw new InvalidOperationException("此控件不支持后台选择");
            ((SelectionItemPattern)pattern).Select();
        } else throw new InvalidOperationException("未知的操作");
        Observations.Remove(Str(a,"token")); POINT after; bool afterValid=GetCursorPos(out after); IntPtr foregroundAfter=GetForegroundWindow();
        return Map("ok",true,"foregroundChanged",foreground==IntPtr.Zero || foregroundAfter==IntPtr.Zero ? (object)null : foreground!=foregroundAfter,"cursorMoved",beforeValid && afterValid ? (object)(before.X!=after.X || before.Y!=after.Y) : null,"inputTelemetryAvailable",beforeValid && afterValid && foreground!=IntPtr.Zero && foregroundAfter!=IntPtr.Zero);
    }
    static string Quote(string s) { return "\""+s.Replace("\\","\\\\").Replace("\"","\\\"")+"\""; }
    static object Launch(Dictionary<string,object> a) {
        string name=Str(a,"desktop"), exe=Path.GetFullPath(Str(a,"executable"));
        if(!name.StartsWith("AgentDock_",StringComparison.Ordinal)) throw new InvalidOperationException("只允许在 AgentDock 创建的实验桌面启动应用");
        if(!File.Exists(exe) || !exe.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("请选择存在的 Windows 应用程序");
        Desktop(name); var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); si.desktop="winsta0\\"+name; si.flags=0x80;
        var command=new StringBuilder("\""+exe+"\" "+Str(a,"arguments")); PROCESS_INFORMATION pi;
        if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,Str(a,"cwd",Path.GetDirectoryName(exe)),ref si,out pi)) throw new InvalidOperationException("启动失败，Windows 错误 "+Marshal.GetLastWin32Error());
        OwnedProcesses.Add((int)pi.pid); CloseHandle(pi.process); CloseHandle(pi.thread);
        return Map("pid",pi.pid,"desktop",name,"notice","应用可能复用原桌面的已有进程；请观察并核实实际窗口所在桌面。");
    }
    static object Handle(string action,Dictionary<string,object> a) {
        if(action=="capabilities") return Map("platform","windows","backend","Windows UI Automation + PrintWindow","physicalInput",false,"humanTakeover",true,"isolatedDesktop","experimental","supportedActions",new[]{"observe","set_value","invoke","select"});
        if(action=="takeover") {
            string name=Str(a,"desktop");
            if(!name.StartsWith("AgentDock_",StringComparison.Ordinal)) throw new InvalidOperationException("当前桌面无需切换，请直接在官方客户端操作");
            string controller=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"AgentDock.Desktop.exe");
            var controllerStart=Launch(Map("desktop",name,"executable",controller,"arguments",name+" Default"));
            return controllerStart;
        }
        if(action=="takeover_status") {
            bool active=false;
            try { var process=Process.GetProcessById(Num(a,"pid")); active=!process.HasExited && String.Equals(process.MainModule.FileName,Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"AgentDock.Desktop.exe"),StringComparison.OrdinalIgnoreCase); } catch(System.ComponentModel.Win32Exception) { active=true; } catch { }
            return Map("active",active);
        }
        if(action=="metrics") { POINT point; bool valid=GetCursorPos(out point); var foreground=GetForegroundWindow(); return Map("available",valid && foreground!=IntPtr.Zero,"foreground",foreground.ToInt64(),"cursorX",valid ? (object)point.X : null,"cursorY",valid ? (object)point.Y : null); }
        if(action=="close_owned") {
            int pid=Num(a,"pid"); if(!OwnedProcesses.Contains(pid)) throw new InvalidOperationException("只能关闭由本组件启动的验证进程");
            foreach(var desk in Desktops.Values) foreach(var h in Windows(desk)) { uint owner; GetWindowThreadProcessId(h,out owner); if(owner==pid) PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero); }
            return Map("ok",true);
        }
        if(action=="ensure_desktop") {
            string name=Str(a,"desktop");
            if(!System.Text.RegularExpressions.Regex.IsMatch(name,@"^AgentDock_[a-zA-Z0-9_]{1,64}$")) throw new InvalidOperationException("只能恢复共作的独立工作桌面");
            if(Desktops.ContainsKey(name)) return Map("name",name,"created",false);
            var h=OpenDesktop(name,0,false,0x01FF); bool created=h==IntPtr.Zero;
            if(created) h=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x01FF,IntPtr.Zero);
            if(h==IntPtr.Zero) throw new InvalidOperationException("恢复工作桌面失败，Windows 错误 "+Marshal.GetLastWin32Error());
            Desktops[name]=h; return Map("name",name,"created",created);
        }
        if(action=="create_desktop") {
            string name="AgentDock_"+Guid.NewGuid().ToString("N").Substring(0,10); var h=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x01FF,IntPtr.Zero);
            if(h==IntPtr.Zero) throw new InvalidOperationException("创建隔离桌面失败，Windows 错误 "+Marshal.GetLastWin32Error()); Desktops[name]=h;
            return Map("name",name,"localFiles",true,"physicalInput",false,"status","experimental");
        }
        if(action=="desktops") return Map("items",new[]{"default"}.Concat(Desktops.Keys.Where(k=>k!="default")).ToArray());
        if(action=="launch") return Launch(a);
        string desktop=Str(a,"desktop","default"); var handle=Desktop(desktop); object result=null; Exception failure=null;
        var thread=new Thread(delegate() {
            try {
                if(!SetThreadDesktop(handle)) throw new InvalidOperationException("无法连接桌面，Windows 错误 "+Marshal.GetLastWin32Error());
                if(action=="windows") result=Map("desktop",desktop,"windows",Windows(handle).Select(WindowInfo).ToArray());
                else if(action=="observe") result=Observe(CheckedWindow(a),!a.ContainsKey("includeScreenshot") || Convert.ToBoolean(a["includeScreenshot"]),desktop.StartsWith("AgentDock_",StringComparison.Ordinal));
                else if(action=="set_value" || action=="invoke" || action=="select" || action=="expand" || action=="collapse" || action=="dismiss_menu") result=Act(action,a);
                else throw new InvalidOperationException("未知操作 "+action);
            } catch(Exception e) { failure=e; }
        });
        // STA initialization can create OLE message windows before this delegate,
        // making SetThreadDesktop fail with ERROR_BUSY. UIA clients use MTA.
        thread.SetApartmentState(ApartmentState.MTA); thread.IsBackground=true; thread.Start();
        if(!thread.Join(14000)) throw new TimeoutException("控件响应超时，操作结果不确定；组件将退出，请重新观察");
        if(failure!=null) throw failure; return result;
    }
    static void Main() {
        SetProcessDPIAware();
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false); string line;
        while((line=Console.ReadLine())!=null) {
            string requestId="";
            try { var request=Json.Deserialize<Dictionary<string,object>>(line); requestId=Str(request,"id"); var a=request.ContainsKey("args") ? (Dictionary<string,object>)request["args"] : new Dictionary<string,object>(); var result=Handle(Str(request,"action"),a); Console.WriteLine(Json.Serialize(Map("id",requestId,"result",result))); }
            catch(Exception e) { Console.WriteLine(Json.Serialize(Map("id",requestId,"error",Map("code",e is TimeoutException ? "native_timeout" : "native_action_failed","message",e.Message)))); if(e is TimeoutException) break; }
        }
        // Do not terminate users' applications on shutdown. Desktop handles stay alive
        // while applications use them; close the test windows manually before exit.
        foreach(var h in Desktops.Values) CloseDesktop(h);
    }
}
